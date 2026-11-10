import { adminCall, profileFromRow, supabase, supabaseConfigured } from "./supabase.mjs";
import { friendlyAuthError, getAuthorizedSession, logout } from "./auth.mjs";
import { inspectBiaFile, recognizeInBodyPhoto, requiredBiaFields, validateInBodyValues } from "./bia-ocr.mjs";
import { convertLegacyProgram, convertImportedProgram, validateV2Program, calculateUsefulSets, inspectProgramDates } from "./workout-metrics.mjs?v=20261110-program-v4";
import { ProgramBuilder } from "./program-builder.mjs?v=20261110-program-v4";

const $ = (id) => document.getElementById(id);
const state = { coach: null, clients: [], selected: null, snapshot: {}, currentProgram: null, drafts: [], versions: [], messages: [], activeDraft: null, dirty: false, channels: [] };
const calls = Object.fromEntries(["createClient", "setClientAccess", "deleteClient", "exportClientData", "recordBia", "saveProgramDraft", "publishProgram", "archiveProgramDraft"].map((name) => [name, (data) => adminCall(name, data)]));
let pendingBia = null, pendingBiaFile = null, biaPhotoUrl = null, biaSourceClientUid = null;
let programAutosaveTimer = null, programEditVersion = 0, programSaveBusy = false, loadingProgram = false;

function esc(value) { return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function initials(profile) { return `${profile.firstName?.[0] || ""}${profile.lastName?.[0] || ""}`.toUpperCase() || "CL"; }
function when(value) { const date = new Date(value || 0); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function notice(target, text, error = false) { target.innerHTML = text ? `<div class="notice${error ? " error" : ""}">${esc(text)}</div>` : ""; }
function setBusy(button, busy, label = "Attendi…") { if (!button.dataset.original) button.dataset.original = button.textContent; button.disabled = busy; button.textContent = busy ? label : button.dataset.original; }
function openModal(id) { $(id).classList.add("show"); }
function closeModal(id) { $(id).classList.remove("show"); }
function randomKey(bytes = 16) { return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (n) => n.toString(16).padStart(2, "0")).join(""); }
function mapProgram(row) { return row ? { id: row.athlete_id, program: row.program, versionId: row.version_id, revision: row.revision, publishedAt: row.published_at, updatedAt: row.updated_at } : null; }
function mapDraft(row) { return { id: row.id, coachId: row.coach_id, clientUid: row.athlete_id, program: row.program, revision: row.revision, status: row.status, updatedAt: row.updated_at }; }
function mapMessage(row) { return { id: row.id, senderId: row.sender_id, targetUid: row.target_id, channel: row.channel, type: row.type, text: row.text, metadata: row.metadata, createdAt: row.created_at }; }
function canonicalJson(value) { if (Array.isArray(value)) return value.map(canonicalJson); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])])); return value; }
function sameJson(a, b) { return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b)); }
function programCheckKey(program) {
  const weeks = program?.settimane || program?.weeks || [];
  return {
    nome: String(program?.nome || program?.name || "").trim(), dal: program?.dal || program?.startDate || "", al: program?.al || program?.endDate || "",
    settimane: weeks.map((week, wi) => ({ n: Number(week.n || wi + 1), giorni: (week.giorni || week.days || []).map((day, di) => ({
      titolo: String(day.titolo || day.title || `Giorno ${String.fromCharCode(65 + di)}`).trim(),
      esercizi: (day.esercizi || day.exercises || []).map((exercise) => ({ nome: String(exercise.nome || exercise.name || "").trim(), serie: Number(exercise.serie ?? exercise.sets), reps: String(exercise.reps ?? exercise.ripetizioni ?? "").trim(), rec: String(exercise.rec ?? exercise.recupero ?? "").trim(), note: String(exercise.note || "").trim() }))
    })) }))
  };
}
function sameProgram(a, b) { if (Number(a?.schemaVersion || a?.schema_version) === 2 || Number(b?.schemaVersion || b?.schema_version) === 2) return sameJson(a, b); return sameJson(programCheckKey(a), programCheckKey(b)); }

function saveStateLabel(text, kind = "") { const target = $("programSaveState"); target.textContent = text; target.className = `pb-save-state ${kind}`.trim(); }
function programStatusLabel(text, kind = "") { const target = $("programStatus"); if (!target) return; target.textContent = text; target.className = `pb-status ${kind}`.trim(); }
function publishedLabel() { return state.currentProgram ? `Pubblicata (v${state.currentProgram.revision || 1})` : "Bozza"; }
function scheduleProgramAutosave() {
  clearTimeout(programAutosaveTimer);
  if (!state.selected || loadingProgram) return;
  programAutosaveTimer = setTimeout(async () => {
    if (!state.dirty || !$("programName").value.trim() || !state.selected) return;
    if (programSaveBusy) { scheduleProgramAutosave(); return; }
    programSaveBusy = true; saveStateLabel("Salvataggio…");
    try { await saveDraft({ autosave: true }); }
    catch (error) { saveStateLabel("Errore: bozza non salvata", "error"); notice($("programNotice"), friendlyAuthError(error), true); }
    finally { programSaveBusy = false; if (state.dirty) scheduleProgramAutosave(); }
  }, 1100);
}
function programChanged() {
  if (loadingProgram) return;
  state.dirty = true; programEditVersion += 1; programStatusLabel("Modifiche non pubblicate", "unsaved"); saveStateLabel("In attesa del salvataggio…", "unsaved");
  $("programScaleToggle").textContent = `Scala attiva: ${programBuilder.scale}`;
  scheduleProgramAutosave();
  if (!$('programJsonPanel').classList.contains("hidden")) $("programJson").value = JSON.stringify(programBuilder.getProgram(), null, 2);
}
const programBuilder = new ProgramBuilder($("programEditor"), { onChange: programChanged });

document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%"; const bytes = crypto.getRandomValues(new Uint8Array(18));
  let value = Array.from(bytes, (n) => alphabet[n % alphabet.length]).join(""); value = `A7!${value.slice(3)}`; $("clientPassword").value = value; return value;
}

function renderClients() {
  const term = $("search").value.trim().toLowerCase(); const filtered = state.clients.filter((client) => `${client.firstName} ${client.lastName} ${client.email}`.toLowerCase().includes(term));
  $("clientList").innerHTML = filtered.length ? filtered.map((client) => `<button class="client${state.selected?.id === client.id ? " on" : ""}" data-client="${client.id}"><span class="avatar">${esc(initials(client))}</span><span class="info"><b>${esc(`${client.firstName || ""} ${client.lastName || ""}`.trim())}</b><small>${esc(client.email)}</small></span><span class="pill ${esc(client.status)}">${client.status === "active" ? "Attivo" : client.status === "suspended" ? "Sospeso" : "In corso"}</span></button>`).join("") : `<p class="sub">Nessun cliente trovato.</p>`;
  document.querySelectorAll("[data-client]").forEach((button) => button.addEventListener("click", () => selectClient(button.dataset.client)));
}
async function loadClients() {
  const { data, error } = await supabase.from("profiles").select("*").eq("trainer_id", state.coach.uid).eq("role", "athlete").order("last_name").limit(100);
  if (error) throw error; state.clients = data.map(profileFromRow); if (state.selected) state.selected = state.clients.find((x) => x.id === state.selected.id) || null; renderClients();
}
function stopDetails() { state.channels.forEach((channel) => supabase.removeChannel(channel)); state.channels = []; }
function watch(table, filter, reload) {
  const channel = supabase.channel(`${table}:${filter}:${crypto.randomUUID()}`).on("postgres_changes", { event: "*", schema: "public", table, filter }, () => reload().catch((e) => alert(friendlyAuthError(e)))).subscribe();
  state.channels.push(channel);
}
async function loadDetails(uid) {
  const [profile, athleteState, program, versions, messages, drafts] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", uid).single(),
    supabase.from("athlete_states").select("*").eq("user_id", uid).maybeSingle(),
    supabase.from("programs").select("*").eq("athlete_id", uid).maybeSingle(),
    supabase.from("program_versions").select("*").eq("athlete_id", uid).order("archived_at", { ascending: false }).limit(20),
    supabase.from("messages").select("*").eq("athlete_id", uid).order("created_at").limit(100),
    supabase.from("program_drafts").select("*").eq("coach_id", state.coach.uid).eq("athlete_id", uid).eq("status", "draft").order("updated_at", { ascending: false }).limit(30)
  ]);
  for (const result of [profile, athleteState, program, versions, messages, drafts]) if (result.error) throw result.error;
  state.selected = profileFromRow(profile.data); state.snapshot = athleteState.data?.snapshot || {}; state.currentProgram = mapProgram(program.data);
  state.versions = versions.data.map((row) => ({ id: row.id, versionId: row.id, revision: row.revision, program: row.program, publishedAt: row.published_at, archivedAt: row.archived_at })); state.messages = messages.data.map(mapMessage); state.drafts = drafts.data.map(mapDraft);
  const index = state.clients.findIndex((item) => item.id === uid); if (index >= 0) state.clients[index] = state.selected;
  renderClients(); renderDetail(); renderActivity(); renderMessages(); renderVersions(); renderDrafts();
  if (!state.activeDraft && !state.dirty) {
    if (state.drafts.length) loadDraft(state.drafts[0]);
    else resetProgramForm(state.currentProgram?.program || null);
  }
}
async function selectClient(uid) {
  if (programSaveBusy) { alert("Attendi che il salvataggio della scheda sia terminato."); return; }
  if (state.dirty && !confirm("Ci sono modifiche non salvate alla scheda. Vuoi abbandonarle?")) return;
  clearTimeout(programAutosaveTimer); resetBiaUpload(); state.dirty = false; stopDetails(); state.selected = state.clients.find((client) => client.id === uid); if (!state.selected) return;
  state.snapshot = {}; state.currentProgram = null; state.versions = []; state.messages = []; state.drafts = []; state.activeDraft = null;
  renderClients(); renderDetail(); resetProgramForm(); $("empty").classList.add("hidden"); $("detail").classList.add("show"); await loadDetails(uid);
  const reload = () => loadDetails(uid); watch("profiles", `id=eq.${uid}`, reload); watch("athlete_states", `user_id=eq.${uid}`, reload); watch("programs", `athlete_id=eq.${uid}`, reload); watch("program_versions", `athlete_id=eq.${uid}`, reload); watch("messages", `athlete_id=eq.${uid}`, reload); watch("program_drafts", `athlete_id=eq.${uid}`, reload);
}

function renderDetail() {
  const client = state.selected; if (!client) return; $("detailAvatar").textContent = initials(client); $("detailName").textContent = `${client.firstName || ""} ${client.lastName || ""}`.trim(); $("detailEmail").textContent = client.email || "";
  $("accessAction").textContent = client.status === "suspended" ? "Riattiva accesso" : "Sospendi accesso";
  $("accountSummary").innerHTML = `<div class="metric">${client.status === "active" ? "Attivo" : client.status === "suspended" ? "Sospeso" : "In elaborazione"}</div><p class="sub">UID: ${esc(client.id)}<br>Primo accesso: ${client.onboardingComplete ? "completato" : "da completare"}</p>`; renderOverview();
}
function renderOverview() {
  if (!state.selected) return; const program = state.currentProgram?.program;
  $("currentProgramSummary").innerHTML = program ? `<div class="metric" style="font-size:19px">${esc(program.nome)}</div><p class="sub">${esc(program.dal)} → ${esc(program.al)}<br>Versione ${esc(state.currentProgram.versionId || "—")}</p>` : `<p class="sub">Il PT non ha ancora assegnato una scheda.</p>`;
  const sessions = Array.isArray(state.snapshot.sessioni) ? state.snapshot.sessioni : []; const lastSession = sessions.slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  $("lastWorkout").innerHTML = lastSession ? `<div class="metric" style="font-size:18px">${esc(lastSession.titolo || "Allenamento")}</div><p class="sub">${when(lastSession.ts)} · ${esc(lastSession.prog || "")}</p>` : `<p class="sub">Nessun allenamento registrato.</p>`;
  const weights = Array.isArray(state.snapshot.pesi) ? state.snapshot.pesi : []; const lastWeight = weights.slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  $("lastWeight").innerHTML = lastWeight ? `<div class="metric">${Number(lastWeight.v).toFixed(1).replace(".", ",")} kg</div><p class="sub">Peso corporeo · ${when(lastWeight.ts)}</p>` : `<p class="sub">Nessuna pesata registrata.</p>`;
}
function renderActivity() {
  const sessions = (state.snapshot.sessioni || []).slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)); $("workoutList").innerHTML = sessions.slice(0, 30).map((item) => `<div class="rowcard"><b>${esc(item.titolo || "Allenamento")}</b><small>${when(item.ts)} · ${esc(item.prog || "")}</small></div>`).join("") || `<p class="sub">Nessun allenamento.</p>`;
  const weights = (state.snapshot.pesi || []).slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)); $("weightList").innerHTML = weights.slice(0, 30).map((item) => `<div class="rowcard"><b>${Number(item.v).toFixed(1).replace(".", ",")} kg</b><small>Peso corporeo · ${when(item.ts)}</small></div>`).join("") || `<p class="sub">Nessuna pesata registrata.</p>`;
  const days = Object.entries(state.snapshot.giornate || {}).sort(([a], [b]) => b.localeCompare(a)); $("checkinList").innerHTML = days.slice(0, 30).map(([date, item]) => `<div class="rowcard"><b>${esc(date)}</b><small>Sonno ${esc(item.sonnoOre ?? "—")} h · Energia ${esc(item.energia ?? "—")} · DOMS ${esc(item.doms ?? "—")}</small></div>`).join("") || `<p class="sub">Nessun check-in.</p>`;
  const loads = new Map(); sessions.forEach((session) => (session.esercizi || []).forEach((exercise) => { const set = (exercise.sets || []).filter((x) => Number(x.kg) > 0).sort((a, b) => Number(b.kg) - Number(a.kg))[0]; if (set && (!loads.has(exercise.nome) || Number(set.kg) > Number(loads.get(exercise.nome).kg))) loads.set(exercise.nome, { ...set, ts: session.ts }); }));
  $("loadList").innerHTML = [...loads.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => `<div class="rowcard"><b>${esc(name)}</b><small>${esc(item.kg)} kg × ${esc(item.reps)} · ${when(item.ts)}</small></div>`).join("") || `<p class="sub">Nessun carico registrato.</p>`;
  renderBia();
}
const biaMetrics = [
  { key: "weightKg", title: "Peso", unit: "kg", color: "#087b65" },
  { key: "skeletalMuscleKg", title: "Massa muscolo scheletrico", unit: "kg", color: "#3867b7" },
  { key: "fatFreeMassKg", title: "Massa magra", unit: "kg", color: "#c47713" }
];
function biaNumber(value, digits = 1) { return Number.isFinite(Number(value)) && value !== null && value !== "" ? `${Number(value).toLocaleString("it-IT", { minimumFractionDigits: digits, maximumFractionDigits: digits })}` : "—"; }
function fatFreeMass(item) {
  const stored = Number(item?.fatFreeMassKg);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const weight = Number(item?.weightKg), fat = Number(item?.bodyFatMassKg);
  return Number.isFinite(weight) && Number.isFinite(fat) && weight > fat ? Math.round((weight - fat) * 100) / 100 : null;
}
function metricValue(item, key) { if (key === "fatFreeMassKg") return fatFreeMass(item); const value = item?.[key]; return value == null || value === "" ? null : Number(value); }
function drawBiaChart(entries, metric) {
  const points = entries.filter((item) => Number.isFinite(metricValue(item, metric.key)) && metricValue(item, metric.key) !== null).slice(-12);
  if (!points.length) return `<section class="bia-chart"><h4>${metric.title}</h4><p class="sub">Dati non ancora disponibili.</p></section>`;
  const width = 340, height = 150, left = 30, right = 14, top = 20, bottom = 25;
  const values = points.map((item) => metricValue(item, metric.key)); const min = Math.min(...values), max = Math.max(...values); const pad = Math.max((max - min) * 0.18, Math.abs(max || 1) * 0.04, 0.5);
  const low = min - pad, high = max + pad; const x = (i) => left + (points.length === 1 ? (width - left - right) / 2 : i * (width - left - right) / (points.length - 1)); const y = (value) => top + (high - value) * (height - top - bottom) / (high - low);
  const line = points.map((item, i) => `${x(i)},${y(metricValue(item, metric.key))}`).join(" ");
  const circles = points.map((item, i) => `<circle cx="${x(i)}" cy="${y(metricValue(item, metric.key))}" r="4" fill="${metric.color}"><title>${biaNumber(metricValue(item, metric.key))} ${metric.unit} · ${esc(new Date(item.measuredAt).toLocaleDateString("it-IT"))}</title></circle>`).join("");
  const first = new Date(points[0].measuredAt), last = new Date(points.at(-1).measuredAt);
  return `<section class="bia-chart"><h4>${metric.title} <span class="bia-note">(${metric.unit})</span></h4><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Andamento ${metric.title}"><line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" stroke="#dce5e2"/><polyline points="${line}" fill="none" stroke="${metric.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${circles}<text class="axis-label" x="${left}" y="${height - 5}">${esc(first.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" }))}</text><text class="axis-label" text-anchor="end" x="${width - right}" y="${height - 5}">${esc(last.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" }))}</text><text class="axis-label" x="${left}" y="13">${biaNumber(max)} ${metric.unit}</text></svg></section>`;
}
function renderSegmental(record) {
  const names = { leftArm: "Braccio sinistro", rightArm: "Braccio destro", trunk: "Tronco", leftLeg: "Gamba sinistra", rightLeg: "Gamba destra" };
  const group = (title, values) => { const details = Object.entries(names).filter(([key]) => values?.[key] != null).map(([key, name]) => `${name}: ${biaNumber(values[key])} kg`).join(" · "); return details ? `<div><b>${title}</b>: ${esc(details)}</div>` : ""; };
  const lean = group("Massa magra", record.segmentalLean), fat = group("Massa grassa", record.segmentalFat);
  return lean || fat ? `<details class="bia-note" style="margin-top:6px"><summary>Valori segmentali</summary>${lean}${fat}</details>` : "";
}
function renderBia() {
  const entries = (Array.isArray(state.snapshot.bia) ? state.snapshot.bia : []).slice().sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime());
  const latest = entries.at(-1);
  $("biaPrimarySummary").innerHTML = latest ? [
    ["Peso", latest.weightKg, "kg"],
    ["Massa muscolare scheletrica", latest.skeletalMuscleKg, "kg"],
    ["Massa magra", fatFreeMass(latest), "kg"]
  ].map(([title, value, unit]) => `<div class="bia-primary-metric"><small>${title}</small><strong>${biaNumber(value)} ${unit}</strong><small>${when(latest.measuredAt)}</small></div>`).join("") : `<p class="sub">Dopo il salvataggio, qui vedrai peso, massa muscolare e massa magra.</p>`;
  $("biaCharts").innerHTML = biaMetrics.map((metric) => drawBiaChart(entries, metric)).join("");
  $("biaList").innerHTML = entries.slice().reverse().slice(0, 30).map((item) => `<div class="rowcard"><b>${when(item.measuredAt)}</b><small>Peso ${biaNumber(item.weightKg)} kg · muscolo ${biaNumber(item.skeletalMuscleKg)} kg · massa magra ${biaNumber(fatFreeMass(item))} kg</small><div class="bia-row-actions"><button class="secondary" type="button" data-bia-detail="${esc(item.id)}">Altri dati e referto</button></div></div>`).join("") || `<p class="sub">Carica qui la foto BIA del cliente: dopo il salvataggio compariranno i valori riconosciuti e l’andamento.</p>`;
}
function renderBiaDetails(item) {
  const details = [
    ["Massa grassa", item.bodyFatMassKg, "kg"], ["Grasso corporeo", item.bodyFatPercent, "%"], ["IMC", item.bmi, ""],
    ["Acqua corporea totale", item.totalBodyWaterL, "L"], ["Proteine", item.proteinKg, "kg"], ["Minerali", item.mineralsKg, "kg"],
    ["Grasso viscerale", item.visceralFatLevel, ""], ["Metabolismo basale", item.basalMetabolicRateKcal, "kcal"],
    ["Rapporto vita/fianchi", item.waistHipRatio, ""], ["Punteggio InBody", item.score, "/100"],
    ["Peso obiettivo", item.targetWeightKg, "kg"], ["Controllo peso", item.weightControlKg, "kg"],
    ["Controllo grasso", item.fatControlKg, "kg"], ["Controllo muscolo", item.muscleControlKg, "kg"]
  ].filter(([, value]) => value != null && value !== "");
  const extra = details.length ? `<h3>Altri valori salvati</h3><div class="bia-details-grid">${details.map(([label, value, unit]) => `<div class="bia-detail-item"><small>${label}</small><b>${biaNumber(value, label === "Minerali" ? 2 : 1)} ${unit}</b></div>`).join("")}</div>` : `<p class="sub">Gli altri parametri non vengono estratti automaticamente perché l’OCR può confondere le cifre. Consulta il referto originale.</p>`;
  const ageSex = item.age != null || item.sex || item.heightCm != null ? `<p class="sub">${item.age == null ? "" : `Età ${biaNumber(item.age, 0)} · `}${item.sex === "male" ? "Maschio · " : item.sex === "female" ? "Femmina · " : ""}${item.heightCm == null ? "" : `Altezza ${biaNumber(item.heightCm, 0)} cm`}</p>` : "";
  const report = item.reportPath ? `<section class="bia-original-report"><h3>Referto originale</h3><div id="biaOriginalPreview" class="bia-original-preview"><p class="sub">Caricamento referto…</p></div><div class="bia-actions"><button class="primary" type="button" data-bia-report="${esc(item.reportPath)}">Apri referto originale</button></div></section>` : `<p class="sub">Per questa rilevazione precedente non è disponibile il file originale.</p>`;
  $("biaDetailsContent").innerHTML = `<p class="sub">Rilevazione del ${when(item.measuredAt)}</p>${ageSex}${extra}<div class="bia-note" style="margin:12px 0">Massa magra = peso − massa grassa (${biaNumber(item.weightKg)} − ${biaNumber(item.bodyFatMassKg)} kg).</div>${report}`;
}
async function loadBiaReportPreview(item) {
  const container = $("biaOriginalPreview"); if (!container || !item.reportPath) return;
  const previewPath = item.reportPreviewPath || item.reportPath;
  try {
    const { data, error } = await supabase.storage.from("bia-reports").createSignedUrl(previewPath, 600);
    if (error || !data?.signedUrl) throw error || new Error("Referto non disponibile.");
    const isPdf = !item.reportPreviewPath && /\.pdf$/i.test(item.reportPath);
    const element = document.createElement(isPdf ? "iframe" : "img");
    element.src = data.signedUrl; element.referrerPolicy = "no-referrer";
    if (isPdf) { element.title = "Referto BIA originale"; element.loading = "lazy"; }
    else { element.alt = "Anteprima del referto BIA originale"; element.loading = "lazy"; }
    container.replaceChildren(element);
  } catch (error) { container.textContent = friendlyAuthError(error); container.classList.add("error"); }
}
const biaInputMap = {
  biaMeasuredAt: "measuredAtLocal", biaWeight: "weightKg", biaFatMass: "bodyFatMassKg", biaMuscle: "skeletalMuscleKg"
};
const biaArchiveExtensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" };
function resetBiaUpload() {
  pendingBia = null; pendingBiaFile = null; biaSourceClientUid = null;
  if (biaPhotoUrl) { URL.revokeObjectURL(biaPhotoUrl); biaPhotoUrl = null; }
  const input = $("biaPhotoInput"); if (input) input.value = "";
  const area = $("biaReviewArea"); if (area) area.classList.add("hidden");
  const status = $("biaUploadStatus"); if (status) { status.textContent = ""; status.classList.remove("error"); }
  const highlight = $("biaBboxHighlight"); if (highlight) highlight.setAttribute("points", "");
}
function numberFromBiaField(id) {
  const raw = $(id).value.trim().replace(/\s/g, "").replace(",", "."); if (!raw) return null;
  const value = Number(raw); return Number.isFinite(value) ? value : null;
}
function writeBiaField(id, value) { $(id).value = value == null ? "" : String(value).replace(".", ","); }
function localDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function reviewValues() {
  return Object.fromEntries(Object.entries(biaInputMap).map(([id, key]) => [key, key === "measuredAtLocal" ? $(id).value || null : numberFromBiaField(id)]));
}
function showBiaFieldPosition(key) {
  const field = pendingBia?.fields?.[key], points = field?.bbox;
  const highlight = $("biaBboxHighlight"); if (!highlight) return;
  highlight.setAttribute("points", Array.isArray(points) && points.length >= 3 ? points.map(([x, y]) => `${Number(x)},${Number(y)}`).join(" ") : "");
}
function updateBiaReview() {
  if (!pendingBia) return;
  const values = reviewValues(), historyOriginal = pendingBia.historyCheck || {};
  const manualHistory = $("biaHistoryConfirmed").checked;
  const confirmation = { manuallyConfirmed: manualHistory };
  const validation = validateInBodyValues({ ...values, confirmation });
  const issues = new Map();
  for (const issue of validation.issues) for (const key of issue.fields) issues.set(key, [...(issues.get(key) || []), issue.message]);
  for (const key of requiredBiaFields) {
    const field = pendingBia.fields?.[key] || { status: "da_verificare", confidence: 0, source: "ocr", bbox: null };
    const node = document.querySelector(`[data-bia-key="${key}"]`), status = node?.querySelector(".bia-field-status");
    const invalid = issues.get(key) || [];
    const empty = values[key] === null || values[key] === "";
    node?.classList.toggle("is-error", Boolean(invalid.length || empty));
    node?.classList.toggle("is-ok", !invalid.length && !empty);
    const provenance = field.source === "corretto_manualmente" ? "Inserito/corretto manualmente" : `Lettura OCR ${Math.round(Number(field.confidence || 0) * 100)}% · controlla sulla foto`;
    if (status) status.textContent = invalid[0] || (empty ? "Dato obbligatorio mancante." : provenance);
  }
  const allFieldsReady = requiredBiaFields.every((key) => values[key] !== null && values[key] !== "" && !issues.has(key));
  const save = $("biaSave"); save.disabled = !(allFieldsReady && manualHistory && validation.ready);
  const fatFree = values.weightKg != null && values.bodyFatMassKg != null && values.weightKg > values.bodyFatMassKg ? values.weightKg - values.bodyFatMassKg : null;
  $("biaLeanPreview").textContent = fatFree == null ? "Massa magra calcolata: inserisci un peso maggiore della massa grassa." : `Massa magra calcolata: ${biaNumber(fatFree)} kg (peso − massa grassa)`;
  const globalIssues = validation.issues.map((issue) => issue.message);
  const hasNeedsReview = !allFieldsReady || !manualHistory;
  const status = $("biaReviewStatus"); status.classList.toggle("error", hasNeedsReview);
  status.textContent = hasNeedsReview
    ? (!allFieldsReady ? globalIssues[0] || "Compila data, peso, massa muscolare e massa grassa." : !manualHistory ? "Controlla i tre numeri sulla foto e spunta la conferma per abilitare il salvataggio." : globalIssues[0] || "Controlla i valori evidenziati.")
    : "Valori compilati e confermati. Premi “Conferma e salva” per aggiornare lo storico.";
  const h = historyOriginal;
  $("biaHistorySummary").textContent = h?.present
    ? `Proposta OCR dallo storico: peso ${h.weightKg ?? "—"} kg · muscolo ${h.skeletalMuscleKg ?? "—"} kg · grasso ${h.bodyFatPercent ?? "—"}%. Confronta i valori principali con la sezione “Analisi Muscolo-Grasso” della foto.`
    : "Storico del referto non riconosciuto: puoi comunque inserire i valori guardando la foto.";
  return { values, confirmation, validation, ready: save.disabled === false };
}
async function setBiaPreview(canvas) {
  if (biaPhotoUrl) URL.revokeObjectURL(biaPhotoUrl);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
  if (!blob) throw new Error("Non è stato possibile preparare l’anteprima del referto.");
  biaPhotoUrl = URL.createObjectURL(blob); $("biaPhotoPreview").src = biaPhotoUrl;
}
async function makeBiaArchivePreview(source) {
  const maxSide = 2600, scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d"); if (!context) throw new Error("Anteprima referto non disponibile.");
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("Non è stato possibile preparare la copia visualizzabile del referto.");
  return blob;
}
function setupBiaUpload() {
  const input = $("biaPhotoInput"), area = $("biaReviewArea"), uploadStatus = $("biaUploadStatus");
  const preview = $("biaPhotoPreview");
  $("biaChoosePhoto").addEventListener("click", () => { if (!state.selected) return; input.click(); });
  input.addEventListener("change", async () => {
    const file = input.files?.[0]; input.value = ""; if (!file) return;
    resetBiaUpload(); biaSourceClientUid = state.selected?.id || null;
    if (!biaSourceClientUid) { uploadStatus.textContent = "Seleziona prima un cliente."; uploadStatus.classList.add("error"); return; }
    try {
      const format = await inspectBiaFile(file);
      pendingBiaFile = file;
      uploadStatus.classList.remove("error"); uploadStatus.textContent = "Lettura locale del referto…";
      pendingBia = await recognizeInBodyPhoto(file, ({ status, progress }) => { const percent = Number.isFinite(progress) ? ` ${Math.round(progress * 100)}%` : ""; uploadStatus.textContent = `${status || "Lettura del referto…"}${percent}`; });
      pendingBia.fileType = format.type;
      await setBiaPreview(pendingBia.preview);
      for (const [id, key] of Object.entries(biaInputMap)) {
        const value = pendingBia.fields?.[key]?.value;
        if (key === "measuredAtLocal") $(id).value = localDateTimeInput(value);
        else writeBiaField(id, value);
      }
      $("biaHistoryConfirmed").checked = false;
      area.classList.remove("hidden");
      for (const [id, key] of Object.entries(biaInputMap)) {
        $(id).onfocus = () => showBiaFieldPosition(key);
        $(id).oninput = () => {
          const field = pendingBia?.fields?.[key] || (pendingBia.fields[key] = { confidence: 1, bbox: null, label: key });
          field.value = key === "measuredAtLocal" ? $(id).value || null : numberFromBiaField(id); field.source = "corretto_manualmente"; field.status = "ok"; field.reason = "";
          updateBiaReview();
        };
        $(id).onchange = $(id).oninput;
      }
      $("biaHistoryConfirmed").onchange = updateBiaReview;
      updateBiaReview();
      uploadStatus.textContent = "Lettura completata. Verifica peso, massa muscolare e massa grassa sulla foto.";
    } catch (error) { pendingBia = null; pendingBiaFile = null; uploadStatus.textContent = error.message || "Non è stato possibile leggere il referto."; uploadStatus.classList.add("error"); }
  });
  $("biaCancelReview").addEventListener("click", resetBiaUpload);
  preview.addEventListener("error", () => { if (pendingBia) { $("biaReviewStatus").textContent = "Anteprima non disponibile. Ricarica il referto."; $("biaReviewStatus").classList.add("error"); } });
  $("biaReviewForm").addEventListener("submit", async (event) => {
    event.preventDefault(); if (!pendingBia || !pendingBiaFile) return;
    if (!state.selected || state.selected.id !== biaSourceClientUid) { $("biaReviewStatus").textContent = "Il cliente selezionato è cambiato. Ricarica il referto."; $("biaReviewStatus").classList.add("error"); return; }
    const reviewed = updateBiaReview(); if (!reviewed.ready) return;
    const measuredAt = new Date(reviewed.values.measuredAtLocal), measuredIso = measuredAt.toISOString();
    if ((state.snapshot.bia || []).some((item) => Math.floor(new Date(item.measuredAt).getTime() / 60000) === Math.floor(measuredAt.getTime() / 60000))) {
      const status = $("biaReviewStatus"); status.textContent = "Esiste già una misurazione con questa data e ora: controlla lo storico prima di proseguire."; status.classList.add("error"); return;
    }
    const button = $("biaSave"); setBusy(button, true, "Salvataggio…"); $("biaReviewStatus").textContent = "Conservo il referto e salvo la rilevazione…"; $("biaReviewStatus").classList.remove("error");
    let reportPath = null, reportPreviewPath = null, persistenceStarted = false, recordWritten = false;
    try {
      const extension = biaArchiveExtensions[pendingBia.fileType];
      if (!extension) throw new Error("Tipo di file originale non supportato per l’archivio privato.");
      const reportUid = crypto.randomUUID(); reportPath = `${biaSourceClientUid}/${reportUid}.${extension}`; reportPreviewPath = `${biaSourceClientUid}/${reportUid}-preview.jpg`;
      const { error: uploadError } = await supabase.storage.from("bia-reports").upload(reportPath, pendingBiaFile, { upsert: false, contentType: pendingBia.fileType, cacheControl: "0" });
      if (uploadError) throw uploadError;
      const previewBlob = await makeBiaArchivePreview(pendingBia.preview);
      const { error: previewError } = await supabase.storage.from("bia-reports").upload(reportPreviewPath, previewBlob, { upsert: false, contentType: "image/jpeg", cacheControl: "0" });
      if (previewError) throw previewError;
      const values = reviewed.values;
      const sourceAudit = {
        fields: Object.fromEntries(requiredBiaFields.map((key) => {
          const field = pendingBia.fields?.[key] || {};
          return [key, { status: "ok", source: field.source === "corretto_manualmente" ? "corretto_manualmente" : "verificato_dal_pt", confidence: 1, bbox: field.bbox || null }];
        })),
        confirmation: reviewed.confirmation
      };
      const payload = {
        clientUid: biaSourceClientUid, measuredAt: measuredIso,
        weightKg: values.weightKg, bodyFatMassKg: values.bodyFatMassKg, skeletalMuscleKg: values.skeletalMuscleKg,
        reportId: pendingBia.fields.reportId?.value || null, device: "InBody120", reportPath, reportPreviewPath, sourceAudit
      };
      persistenceStarted = true;
      const result = await calls.recordBia(payload);
      recordWritten = true;
      const { data: persisted, error: verifyError } = await supabase.from("athlete_states").select("snapshot, revision").eq("user_id", biaSourceClientUid).maybeSingle();
      if (verifyError) throw new Error(`BIA salvata, ma verifica database non riuscita: ${friendlyAuthError(verifyError)}`);
      const persistedRecords = Array.isArray(persisted?.snapshot?.bia) ? persisted.snapshot.bia : [];
      if (!persistedRecords.some((item) => item.id === result.record?.id)) throw new Error("BIA non trovata nel database dopo il salvataggio. Ricarica lo storico prima di riprovare.");
      state.snapshot = persisted.snapshot; renderBia(); renderActivity(); resetBiaUpload(); uploadStatus.textContent = "Referto BIA salvato nel database. Foto, valori e grafici resteranno disponibili dopo il ricaricamento.";
    } catch (error) {
      const uploadedPaths = [reportPath, reportPreviewPath].filter(Boolean);
      if (uploadedPaths.length && !recordWritten) {
        let referenced = persistenceStarted;
        if (persistenceStarted) {
          const { data } = await supabase.from("athlete_states").select("snapshot").eq("user_id", biaSourceClientUid).maybeSingle().catch(() => ({ data: null }));
          referenced = (data?.snapshot?.bia || []).some((item) => uploadedPaths.includes(item.reportPath) || uploadedPaths.includes(item.reportPreviewPath));
        }
        if (!referenced) await supabase.storage.from("bia-reports").remove(uploadedPaths).catch(() => {});
      }
      const status = $("biaReviewStatus"); status.textContent = friendlyAuthError(error); status.classList.add("error");
    } finally { setBusy(button, false); updateBiaReview(); }
  });
  const openBiaReport = async (button) => {
    const tab = window.open("about:blank", "_blank");
    try {
      const { data, error } = await supabase.storage.from("bia-reports").createSignedUrl(button.dataset.biaReport, 60);
      if (error || !data?.signedUrl) throw error || new Error("Referto non disponibile.");
      if (tab) { tab.opener = null; tab.location = data.signedUrl; } else window.location.assign(data.signedUrl);
    } catch (error) { tab?.close(); alert(friendlyAuthError(error)); }
  };
  $("biaList").addEventListener("click", (event) => {
    const detailsButton = event.target.closest("[data-bia-detail]");
    if (detailsButton) {
      const item = (state.snapshot.bia || []).find((entry) => entry.id === detailsButton.dataset.biaDetail);
      if (item) { renderBiaDetails(item); openModal("biaDetailsModal"); loadBiaReportPreview(item); }
      return;
    }
    const reportButton = event.target.closest("[data-bia-report]");
    if (reportButton) openBiaReport(reportButton);
  });
  $("biaDetailsContent").addEventListener("click", (event) => { const button = event.target.closest("[data-bia-report]"); if (button) openBiaReport(button); });
}
function renderMessages() { $("messageList").innerHTML = state.messages.map((item) => `<div class="rowcard"><b>${item.senderId === state.coach?.uid ? "Tu" : esc(state.selected?.firstName || "Cliente")}</b><small>${when(item.createdAt)}</small><div style="margin-top:6px;font-size:13px">${esc(item.text)}</div></div>`).join("") || `<p class="sub">Nessun messaggio.</p>`; }
function resetProgramForm(program = null) {
  clearTimeout(programAutosaveTimer); loadingProgram = true; state.activeDraft = null; state.dirty = false;
  const value = program ? structuredClone(program) : null;
  $("programName").value = value?.nome || value?.name || ""; $("programStart").value = value?.dal || value?.startDate || ""; $("programEnd").value = value?.al || value?.endDate || "";
  programBuilder.setProgram(value); programBuilder.setMeta({ nome: $("programName").value, dal: $("programStart").value, al: $("programEnd").value });
  $("programJson").value = JSON.stringify(programBuilder.getProgram(), null, 2); $("programJsonPanel").classList.add("hidden"); $("programEditor").classList.remove("hidden"); $("programViewToggle").textContent = "Vista JSON";
  notice($("programNotice"), ""); programStatusLabel(program ? publishedLabel() : "Bozza"); saveStateLabel("Nessuna modifica"); loadingProgram = false;
}
function formProgram() {
  const invalid = $("programEditor").querySelector("[aria-invalid='true'], .invalid");
  if (invalid) { invalid.focus(); throw new Error("Correggi i campi evidenziati in rosso prima di salvare."); }
  const program = programBuilder.getProgram();
  program.nome = $("programName").value.trim(); program.dal = $("programStart").value; program.al = $("programEnd").value; program.schemaVersion = 2;
  const result = validateV2Program(program);
  if (!result.valid) { const first = result.errors[0]; throw new Error(`${first.path}: ${first.message}`); }
  return result.program;
}
function loadDraft(draft) {
  if (state.dirty && !confirm("Abbandonare le modifiche non salvate?")) return;
  clearTimeout(programAutosaveTimer); loadingProgram = true; state.activeDraft = draft; state.dirty = false;
  const program = draft.program || {}; $("programName").value = program.nome || program.name || ""; $("programStart").value = program.dal || program.startDate || ""; $("programEnd").value = program.al || program.endDate || "";
  programBuilder.setProgram(program); programBuilder.setMeta({ nome: $("programName").value, dal: $("programStart").value, al: $("programEnd").value }); programStatusLabel("Bozza");
  $("programJson").value = JSON.stringify(programBuilder.getProgram(), null, 2); saveStateLabel(`Bozza caricata · revisione ${draft.revision}`); notice($("programNotice"), `Bozza caricata · revisione ${draft.revision}`); loadingProgram = false;
}
function renderDrafts() {
  $("draftList").innerHTML = state.drafts.map((draft) => `<article class="rowcard draft-item"><div><b>${esc(draft.program?.nome || "Senza nome")}</b><small>Ultima modifica · ${when(draft.updatedAt)} · revisione ${draft.revision}</small></div><div class="bar"><button class="secondary" type="button" data-draft-resume="${esc(draft.id)}">Riprendi</button><button class="secondary" type="button" data-draft-archive="${esc(draft.id)}">Archivia</button></div></article>`).join("") || `<p class="sub">Nessuna bozza.</p>`;
  document.querySelectorAll("[data-draft-resume]").forEach((button) => button.addEventListener("click", () => loadDraft(state.drafts.find((item) => item.id === button.dataset.draftResume))));
  document.querySelectorAll("[data-draft-archive]").forEach((button) => button.addEventListener("click", () => archiveDraftById(button.dataset.draftArchive)));
}
function versionMetrics(program = {}) {
  const normalized = convertLegacyProgram(program), weeks = normalized.settimane || [];
  const sessions = weeks.reduce((sum, week) => sum + (week.giorni || week.days || []).length, 0);
  const sets = weeks.reduce((sum, week) => sum + (week.giorni || week.days || []).reduce((inner, day) => inner + calculateUsefulSets(day, normalized.settings), 0), 0);
  return { weeks: weeks.length, sessions, sets };
}
function renderVersions() {
  const activeId = state.currentProgram?.versionId;
  const active = state.currentProgram ? [{ ...state.currentProgram, id: activeId, isActive: true }] : [];
  const versions = [...active, ...state.versions.filter((version) => version.versionId !== activeId).map((version) => ({ ...version, isActive: false }))];
  $("versionList").innerHTML = versions.map((version) => {
    const stats = versionMetrics(version.program), number = version.revision || 1, id = version.versionId || version.id;
    return `<article class="rowcard version-item"><div class="version-heading"><b>Versione ${number} · ${esc(version.program?.nome || "Scheda")}</b>${version.isActive ? `<span class="pill">Attiva</span>` : ""}</div><small>Pubblicata il ${when(version.publishedAt)} · ${stats.weeks} settimane, ${stats.sessions} sedute, ${stats.sets} serie utili</small><div class="bar"><button class="secondary" type="button" data-version-preview="${esc(id)}">Anteprima</button><button class="secondary" type="button" data-version-restore="${esc(id)}">Ripristina come bozza</button><button class="secondary" type="button" title="Copia ID" aria-label="Copia ID versione ${number}" data-version-copy="${esc(id)}">Copia ID</button></div></article>`;
  }).join("") || `<p class="sub">Nessuna versione precedente.</p>`;
  document.querySelectorAll("[data-version-preview]").forEach((button) => button.addEventListener("click", () => previewVersion(button.dataset.versionPreview)));
  document.querySelectorAll("[data-version-restore]").forEach((button) => button.addEventListener("click", () => restoreVersionAsDraft(button.dataset.versionRestore)));
  document.querySelectorAll("[data-version-copy]").forEach((button) => button.addEventListener("click", async () => { try { await navigator.clipboard.writeText(button.dataset.versionCopy); button.textContent = "ID copiato"; setTimeout(() => { button.textContent = "Copia ID"; }, 1500); } catch { notice($("programNotice"), "Impossibile copiare l’ID in questo browser.", true); } }));
}
function findVersion(versionId) { if (state.currentProgram?.versionId === versionId) return { ...state.currentProgram, versionId, isActive: true }; return state.versions.find((version) => version.versionId === versionId); }
function previewVersion(versionId) {
  const version = findVersion(versionId); if (!version) return;
  const source = version.program || {}, program = convertLegacyProgram(source), weeks = program.settimane || [];
  $("versionPreviewTitle").textContent = `${program.nome || "Scheda"} · Versione ${version.revision || 1}${version.isActive ? " · Attiva" : ""}`;
  $("versionPreviewContent").innerHTML = `<p class="sub">${esc(program.dal || "—")} → ${esc(program.al || "—")} · ${weeks.length} settimane</p>${weeks.map((week, index) => `<section class="version-preview-week"><h3>Settimana ${week.n || index + 1}${week.fase ? ` · ${esc(week.fase)}` : ""}</h3>${(week.giorni || []).map((day) => `<div><b>${esc(day.title || day.titolo || "Seduta")}</b><ul>${(day.blocks || []).flatMap((block) => block.exercises || []).map((exercise) => `<li>${esc(exercise.name || "Esercizio senza nome")} · ${esc((exercise.sets || []).length)} serie</li>`).join("") || (day.esercizi || []).map((exercise) => `<li>${esc(exercise.nome || "Esercizio")} · ${esc(exercise.serie || "—")} serie</li>`).join("")}</ul></div>`).join("")}</section>`).join("")}`;
  openModal("programVersionModal");
}
async function restoreVersionAsDraft(versionId) {
  const version = findVersion(versionId); if (!version || !state.selected) return;
  const stats = versionMetrics(version.program);
  if (state.dirty && !confirm("Ci sono modifiche non salvate. Ripristinare la versione le abbandonerà e creerà una nuova bozza. Continuare?")) return;
  if (!confirm(`Ripristinare la versione ${version.revision || 1} come nuova bozza? La versione attiva resterà invariata.\n\n${stats.weeks} settimane · ${stats.sessions} sedute · ${stats.sets} serie utili`)) return;
  clearTimeout(programAutosaveTimer);
  try {
    const response = await calls.saveProgramDraft({ clientUid: state.selected.id, draftId: null, expectedRevision: 0, program: convertLegacyProgram(version.program) });
    state.activeDraft = null; state.dirty = false; await loadDetails(state.selected.id);
    const draft = state.drafts.find((item) => item.id === response.draftId) || state.drafts[0]; if (draft) loadDraft(draft);
    notice($("programNotice"), `Versione ripristinata come bozza · revisione ${response.revision}. La versione attiva non è stata modificata.`);
  } catch (error) { notice($("programNotice"), friendlyAuthError(error), true); }
}
async function archiveDraftById(draftId) {
  const draft = state.drafts.find((item) => item.id === draftId); if (!draft || !confirm(`Archiviare la bozza “${draft.program?.nome || "Senza nome"}”? I dati restano conservati.`)) return;
  if (state.activeDraft?.id === draftId && state.dirty && !confirm("La bozza contiene modifiche non salvate. Archiviandola, queste ultime modifiche non verranno conservate. Continuare?")) return;
  clearTimeout(programAutosaveTimer);
  try { await calls.archiveProgramDraft({ draftId }); if (state.activeDraft?.id === draftId) { state.activeDraft = null; state.dirty = false; } await loadDetails(state.selected.id); notice($("programNotice"), "Bozza archiviata; i dati sono conservati."); }
  catch (error) { notice($("programNotice"), friendlyAuthError(error), true); }
}
async function saveDraft({ autosave = false } = {}) {
  if (!state.selected) throw new Error("Seleziona un cliente.");
  const clientUid = state.selected.id, editVersion = programEditVersion, program = formProgram();
  const response = await calls.saveProgramDraft({ clientUid, draftId: state.activeDraft?.id || null, expectedRevision: state.activeDraft?.revision || 0, program });
  const { data, error } = await supabase.from("program_drafts").select("*").eq("id", response.draftId).eq("coach_id", state.coach.uid).eq("athlete_id", clientUid).single();
  if (error) throw error;
  if (Number(data.revision) !== Number(response.revision) || data.status !== "draft" || !sameProgram(data.program, program)) throw new Error("La bozza è stata inviata ma non coincide con i dati riletti dal database. Riapri la bozza e verifica le modifiche.");
  state.activeDraft = mapDraft(data); state.drafts = [state.activeDraft, ...state.drafts.filter((item) => item.id !== state.activeDraft.id)]; renderDrafts();
  if (editVersion === programEditVersion) { state.dirty = false; programStatusLabel("Bozza"); saveStateLabel(`Salvato alle ${new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`); }
  else { state.dirty = true; scheduleProgramAutosave(); }
  if (!autosave) notice($("programNotice"), `Bozza verificata nel database · revisione ${response.revision}. Per renderla visibile al cliente premi “Pubblica”.`);
  return state.activeDraft;
}
async function downloadExport() { if (!state.selected) return; const response = await calls.exportClientData({ clientUid: state.selected.id }); const blob = new Blob([JSON.stringify(response, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `lippolis-${state.selected.lastName || "cliente"}-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); }

document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".tabs button").forEach((item) => item.classList.toggle("on", item === button)); document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("on", tab.id === `tab-${button.dataset.tab}`)); }));
$("search").addEventListener("input", renderClients); $("addClient").addEventListener("click", () => { $("addForm").classList.remove("hidden"); $("createdResult").classList.add("hidden"); $("addForm").reset(); generatePassword(); notice($("addNotice"), ""); openModal("addModal"); }); $("generatePassword").addEventListener("click", generatePassword);
$("addForm").addEventListener("submit", async (event) => { event.preventDefault(); const button = $("createClient"); setBusy(button, true, "Creazione…"); notice($("addNotice"), ""); const password = $("clientPassword").value; try { const response = await calls.createClient({ firstName: $("clientFirst").value, lastName: $("clientLast").value, email: $("clientEmail").value, password, idempotencyKey: randomKey() }); $("createdCredentials").textContent = `${response.email}\n${password}`; $("addForm").classList.add("hidden"); $("createdResult").classList.remove("hidden"); await loadClients(); } catch (error) { notice($("addNotice"), friendlyAuthError(error), true); } finally { setBusy(button, false); } });
$("accessAction").addEventListener("click", async () => { const action = state.selected.status === "suspended" ? "reactivate" : "suspend"; if (action === "suspend" && !confirm(`Sospendere immediatamente l’accesso di ${state.selected.firstName}? I dati saranno conservati.`)) return; const button = $("accessAction"); setBusy(button, true); try { await calls.setClientAccess({ clientUid: state.selected.id, action }); await loadDetails(state.selected.id); } catch (error) { alert(friendlyAuthError(error)); } finally { setBusy(button, false); } });
$("exportClient").addEventListener("click", () => downloadExport().catch((error) => alert(friendlyAuthError(error)))); $("deleteClient").addEventListener("click", () => { $("deletePrompt").textContent = `Stai eliminando ${state.selected.firstName} ${state.selected.lastName} (${state.selected.email}). Account e dati esclusivi saranno rimossi.`; $("deleteConfirmation").value = ""; notice($("deleteNotice"), ""); openModal("deleteModal"); }); $("exportBeforeDelete").addEventListener("click", () => downloadExport().catch((error) => notice($("deleteNotice"), friendlyAuthError(error), true)));
$("confirmDelete").addEventListener("click", async () => { const button = $("confirmDelete"); setBusy(button, true, "Eliminazione…"); try { await calls.deleteClient({ clientUid: state.selected.id, confirmationEmail: $("deleteConfirmation").value.trim() }); closeModal("deleteModal"); stopDetails(); state.selected = null; $("detail").classList.remove("show"); $("empty").classList.remove("hidden"); await loadClients(); } catch (error) { notice($("deleteNotice"), friendlyAuthError(error), true); } finally { setBusy(button, false); } });
[$("programName"), $("programStart"), $("programEnd")].forEach((input) => input.addEventListener("input", () => {
  programBuilder.setMeta({ nome: $("programName").value, dal: $("programStart").value, al: $("programEnd").value });
}));
[$("programStart"), $("programEnd")].forEach((input) => input.addEventListener("change", () => programBuilder.render()));
$("programViewToggle").addEventListener("click", () => {
  const jsonVisible = !$("programJsonPanel").classList.contains("hidden");
  if (!jsonVisible) { $("programJson").value = JSON.stringify(programBuilder.getProgram(), null, 2); $("programJsonPanel").classList.remove("hidden"); $("programEditor").classList.add("hidden"); $("programViewToggle").textContent = "Vista editor"; }
  else { $("programJsonPanel").classList.add("hidden"); $("programEditor").classList.remove("hidden"); $("programViewToggle").textContent = "Vista JSON"; }
});
$("programScaleToggle").textContent = `Scala attiva: ${programBuilder.scale}`;
$("programScaleToggle").addEventListener("click", () => { const scale = programBuilder.scale === "RIR" ? "RPE" : "RIR"; programBuilder.setScale(scale); $("programScaleToggle").textContent = `Scala attiva: ${scale}`; });
$("applyProgramJson").addEventListener("click", () => {
  try {
    const parsed = JSON.parse($("programJson").value);
    const source = Array.isArray(parsed) ? { settimane: parsed } : parsed.PROGRAMMA || parsed.program || parsed;
    const result = convertImportedProgram({ ...source, nome: source.nome || source.name || $("programName").value, dal: source.dal || source.startDate || $("programStart").value, al: source.al || source.endDate || $("programEnd").value });
    if (!result.valid) throw new Error(`${result.errors[0].path}: ${result.errors[0].message}`);
    const program = result.program;
    const warningText = result.warnings.length ? `\n\nAvvisi:\n• ${[...new Set(result.warnings.map((item) => `${item.path}: ${item.message}`))].slice(0, 8).join("\n• ")}` : "";
    if (!confirm(`Anteprima JSON\n\n${program.nome || "Scheda senza nome"}\n${program.settimane.length} settimane\n${program.settimane.reduce((sum, week) => sum + week.giorni.length, 0)} sedute\n${program.calculated?.totals.usefulSets || 0} serie utili${warningText}\n\nApplicare al costruttore? Nessun dato sarà salvato finché non premi Salva bozza.`)) return;
    loadingProgram = true; programBuilder.setProgram(result.program); $("programName").value = result.program.nome; $("programStart").value = result.program.dal; $("programEnd").value = result.program.al; loadingProgram = false;
    programChanged(); notice($("programJsonNotice"), "JSON applicato al costruttore. Premi Salva bozza per conservarlo.");
  } catch (error) { loadingProgram = false; notice($("programJsonNotice"), friendlyAuthError(error), true); }
});
$("newDraft").addEventListener("click", () => { if (state.dirty && !confirm("Scartare la scheda corrente e crearne una nuova?")) return; clearTimeout(programAutosaveTimer); resetProgramForm(); });
$("duplicateDraft").addEventListener("click", () => {
  if (state.dirty && !confirm("Duplicare la versione corrente e scartare le modifiche non salvate?")) return;
  clearTimeout(programAutosaveTimer); state.activeDraft = null; loadingProgram = true; const copy = programBuilder.duplicate(); $("programName").value = copy.nome; loadingProgram = false; programChanged(); notice($("programNotice"), "Copia indipendente pronta. Il salvataggio automatico la conserverà come nuova bozza.");
});
$("saveDraft").addEventListener("click", async () => { if (programSaveBusy) return notice($("programNotice"), "È già in corso un salvataggio.", true); clearTimeout(programAutosaveTimer); const button = $("saveDraft"); setBusy(button, true, "Salvataggio…"); programSaveBusy = true; saveStateLabel("Salvataggio…"); try { await saveDraft(); } catch (error) { saveStateLabel("Errore: riprova", "error"); notice($("programNotice"), friendlyAuthError(error), true); } finally { programSaveBusy = false; setBusy(button, false); } });
$("publishProgram").addEventListener("click", async () => {
  if (programSaveBusy) return notice($("programNotice"), "Attendi che il salvataggio della bozza sia terminato.", true);
  const button = $("publishProgram"), clientUid = state.selected?.id; if (!clientUid) return;
  let draftProgram;
  try {
    draftProgram = formProgram(); const check = validateV2Program(draftProgram, { forPublish: true });
    if (!check.valid) return notice($("programNotice"), `${check.errors[0].path}: ${check.errors[0].message}`, true);
    const dates = inspectProgramDates(draftProgram), sessions = draftProgram.settimane.reduce((sum, week) => sum + week.giorni.length, 0);
    const useful = draftProgram.settimane.reduce((sum, week) => sum + week.giorni.reduce((weekSum, day) => weekSum + calculateUsefulSets(day, draftProgram.settings), 0), 0);
    const warnings = [...check.warnings, ...dates.warnings].map((item) => item.message);
    const summary = `Pubblicare “${draftProgram.nome}”?\n\n${draftProgram.settimane.length} settimane · ${sessions} sedute · ${useful} serie utili\n${draftProgram.dal || "Data iniziale mancante"} → ${draftProgram.al || "Data finale mancante"}\n\nIl cliente vedrà questa scheda in Workout.${warnings.length ? `\n\nAvvisi:\n• ${[...new Set(warnings)].join("\n• ")}` : ""}`;
    if (!confirm(summary)) return;
  } catch (error) { return notice($("programNotice"), friendlyAuthError(error), true); }
  clearTimeout(programAutosaveTimer); setBusy(button, true, "Pubblicazione…"); let draft = state.activeDraft;
  try {
    if (state.dirty || !draft) draft = await saveDraft();
    const response = await calls.publishProgram({ clientUid, draftId: draft.id, expectedRevision: draft.revision }); state.activeDraft = null; state.dirty = false;
    const { data, error } = await supabase.from("programs").select("*").eq("athlete_id", clientUid).single(); if (error) throw error;
    if (data.version_id !== response.versionId || !sameProgram(data.program, draft.program)) throw new Error("Pubblicazione non verificata nel database. Ricarica la scheda e controlla la versione attiva.");
    await loadDetails(clientUid); if (state.currentProgram?.versionId !== response.versionId) throw new Error("La scheda è nel database, ma non è stata riletta come versione attiva.");
    notice($("programNotice"), `Scheda pubblicata e verificata · il cliente la vede in Workout · versione ${response.versionId}`); programStatusLabel(publishedLabel()); saveStateLabel("Pubblicata e verificata");
  } catch (error) { if (clientUid && !state.activeDraft) await loadDetails(clientUid).catch(() => {}); notice($("programNotice"), friendlyAuthError(error), true); saveStateLabel("Errore: riprova", "error"); }
  finally { setBusy(button, false); }
});
$("archiveDraft").addEventListener("click", async () => { if (!state.activeDraft) return notice($("programNotice"), "Carica prima una bozza.", true); return archiveDraftById(state.activeDraft.id); });
$("importProgram").addEventListener("click", () => $("importProgramFile").click()); $("importProgramFile").addEventListener("change", async () => {
  const file = $("importProgramFile").files[0]; if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()), source = Array.isArray(parsed) ? { settimane: parsed } : parsed.PROGRAMMA || parsed.program || parsed;
    const result = convertImportedProgram({ ...source, nome: source.nome || source.name || $("programName").value, dal: source.dal || source.startDate || $("programStart").value, al: source.al || source.endDate || $("programEnd").value });
    if (!result.valid) throw new Error(`${result.errors[0].path}: ${result.errors[0].message}`);
    const program = result.program;
    const workoutCount = program.settimane.reduce((sum, week) => sum + week.giorni.length, 0), setCount = program.settimane.reduce((sum, week) => sum + week.giorni.reduce((sub, day) => sub + calculateUsefulSets(day), 0), 0);
    const warning = Number(source.schemaVersion || source.schema_version) === 2 ? "Il file usa il formato v2." : "Il formato sorgente viene mantenuto in legacyBackup.";
    const warnings = result.warnings.map((item) => `${item.path}: ${item.message}`);
    if (!confirm(`Anteprima importazione\n\n${program.nome || "Scheda senza nome"}\n${program.settimane.length} settimane · ${workoutCount} sedute · ${setCount} serie utili\n${warning}${warnings.length ? `\n\nAvvisi:\n• ${[...new Set(warnings)].slice(0, 8).join("\n• ")}` : ""}\n\nVuoi caricarla nel costruttore? Non verrà salvata finché non confermi il salvataggio.`)) return;
    if (state.dirty && !confirm("Sostituire i dati correnti nel costruttore?")) return;
    loadingProgram = true; state.activeDraft = null; $("programName").value = program.nome; $("programStart").value = program.dal; $("programEnd").value = program.al; programBuilder.setProgram(program); loadingProgram = false; programChanged();
    notice($("programNotice"), "Importazione caricata nel costruttore dopo anteprima. Controlla e salva la bozza.");
  } catch (error) { loadingProgram = false; notice($("programNotice"), friendlyAuthError(error), true); }
  finally { $("importProgramFile").value = ""; }
});
$("sendMessage").addEventListener("click", async () => { const text = $("coachMessage").value.trim(); if (!text || !state.selected) return; const button = $("sendMessage"); setBusy(button, true, "Invio…"); try { const { error } = await supabase.from("messages").insert({ athlete_id: state.selected.id, sender_id: state.coach.uid, target_id: state.selected.id, channel: "thread", text }); if (error) throw error; $("coachMessage").value = ""; } catch (error) { alert(friendlyAuthError(error)); } finally { setBusy(button, false); } });
$("printBia").addEventListener("click", () => window.print());
setupBiaUpload();
$("changePassword").addEventListener("click", () => { $("currentPassword").value = ""; $("coachNewPassword").value = ""; notice($("passwordNotice"), ""); openModal("passwordModal"); }); $("savePassword").addEventListener("click", async () => { const button = $("savePassword"); setBusy(button, true); try { const { error: authError } = await supabase.auth.signInWithPassword({ email: state.coach.email, password: $("currentPassword").value }); if (authError) throw authError; if ($("coachNewPassword").value.length < 12) throw new Error("La nuova password deve contenere almeno 12 caratteri."); const { error } = await supabase.auth.updateUser({ password: $("coachNewPassword").value }); if (error) throw error; notice($("passwordNotice"), "Password aggiornata."); } catch (error) { notice($("passwordNotice"), friendlyAuthError(error), true); } finally { setBusy(button, false); } });
$("logout").addEventListener("click", logout); window.addEventListener("beforeunload", (event) => { if (!state.dirty) return; event.preventDefault(); event.returnValue = ""; });

if (!supabaseConfigured) { alert("Configura Supabase in supabase-config.js."); location.replace("index.html"); }
else { const session = await getAuthorizedSession({ requireRole: "coach" }); if (session.reason) { alert(session.reason); location.replace("index.html"); } else { state.coach = { uid: session.user.uid, ...session.profile }; $("coachIdentity").textContent = `${state.coach.displayName || state.coach.email}\n${state.coach.email || ""}`; await loadClients(); supabase.channel(`clients:${state.coach.uid}`).on("postgres_changes", { event: "*", schema: "public", table: "profiles", filter: `trainer_id=eq.${state.coach.uid}` }, () => loadClients().catch(() => {})).subscribe(); } }
