import { adminCall, profileFromRow, supabase, supabaseConfigured } from "./supabase.mjs";
import { friendlyAuthError, getAuthorizedSession, logout } from "./auth.mjs";
import { inspectBiaFile, recognizeInBodyPhoto, requiredBiaFields, validateInBodyValues } from "./bia-ocr.mjs";
import { convertLegacyProgram, convertImportedProgram, validateV2Program, calculateUsefulSets, inspectProgramDates } from "./workout-metrics.mjs?v=20261113-program-v5";
import { ProgramBuilder } from "./program-builder.mjs?v=20261113-program-v5";
import { mountCoachNutrition } from "./nutrition-coach.mjs";

const $ = (id) => document.getElementById(id);
const state = { coach: null, clients: [], selected: null, snapshot: {}, currentProgram: null, drafts: [], versions: [], messages: [], activeDraft: null, dirty: false, channels: [] };
const calls = Object.fromEntries(["createClient", "setClientAccess", "deleteClient", "exportClientData", "recordBia", "saveProgramDraft", "publishProgram", "archiveProgramDraft"].map((name) => [name, (data) => adminCall(name, data)]));
let pendingBia = null, pendingBiaFile = null, biaPhotoUrl = null, biaSourceClientUid = null, biaSaveBusy = false;
let biaReadRequest = 0;
let programAutosaveTimer = null, programEditVersion = 0, programSaveBusy = false, loadingProgram = false;
let coachRoute = "home", directoryTab = "overview", directoryHistoryTarget = "";
let clientSelection = 0, detailsRequest = 0, detailsApplied = 0, scheduleRequest = 0;
let visibleSessions = 30;
const nutrition = mountCoachNutrition($("coachNutrition"), () => state.selected?.id, () => state.coach?.uid);

function esc(value) { return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function initials(profile) { return `${profile.firstName?.[0] || ""}${profile.lastName?.[0] || ""}`.toUpperCase() || "CL"; }
function when(value) { const date = new Date(value); return value == null || value === "" || Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" }).format(date); }
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
    const attemptedEdit = programEditVersion;
    programSaveBusy = true; saveStateLabel("Salvataggio…");
    try { await saveDraft({ autosave: true }); }
    catch (error) { saveStateLabel("Errore: bozza non salvata", "error"); notice($("programNotice"), friendlyAuthError(error), true); }
    finally { programSaveBusy = false; if (state.dirty && attemptedEdit !== programEditVersion) scheduleProgramAutosave(); }
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

const coachIcons = {
  priority: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
  clients: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>',
  program: '<path d="M3 9v6m3-8v10m12-10v10m3-8v6M6 12h12"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.8 7M3 5v6h6m3-4v5l3 2"/>',
  metrics: '<path d="M4 3v17h17M8 16l4-6 4 3 4-7"/>',
  nutrition: '<path d="M12 8c-2.5-4-8-2-8 3 0 5 3 9 5 9 1 0 2-.8 3-.8s2 .8 3 .8c2 0 5-4 5-9 0-5-5.5-7-8-3zm0-1c0-2 1-4 4-4"/>',
  agenda: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-13 5h1m3 0h1m3 0h1"/>',
  messages: '<path d="M20 16a2 2 0 0 1-2 2H9l-5 3v-5a2 2 0 0 1-1-2V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2zM7 9h9m-9 4h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>'
};
document.querySelectorAll("[data-coach-icon]").forEach((node) => {
  node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${coachIcons[node.dataset.coachIcon] || ""}</svg>`;
});

const clientStatus = (client) => ({ active: "Attivo", suspended: "Sospeso" })[client.status] || "In corso";
const clientName = (client) => `${client.firstName || ""} ${client.lastName || ""}`.trim() || client.displayName || client.email || "Cliente";
const directoryLabels = { overview: "Clienti", program: "Workout", history: "Revisione carichi", nutrition: "Consigli alimentari", messages: "Messaggi" };

function setCoachTab(tab, target = "") {
  document.querySelectorAll(".tabs [data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("on", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".tab").forEach((section) => section.classList.toggle("on", section.id === `tab-${tab}`));
  if (!target) return;
  const card = $(target)?.closest(".card");
  requestAnimationFrame(() => card?.scrollIntoView({ block: "start" }));
}

function detailStatus(title = "Seleziona un cliente", hint = "Apri il profilo per vedere schede, risultati e conversazioni.") {
  $("detailStatus").textContent = title;
  $("detailStatusHint").textContent = hint;
  $("detail").classList.remove("show");
  $("empty").classList.remove("hidden");
  $("coachWorkspace").classList.remove("has-client");
}

function clearClientSelection() {
  clientSelection += 1;
  clearTimeout(programAutosaveTimer);
  resetBiaUpload();
  stopDetails();
  state.selected = null;
  state.dirty = false;
  state.activeDraft = null;
  visibleSessions = 30;
  $("workoutList").replaceChildren();
  $("loadList").replaceChildren();
  closeModal("programVersionModal");
  closeModal("biaDetailsModal");
  nutrition.select(null);
  detailStatus();
  renderClients();
}

function canLeaveClient() {
  if (programSaveBusy || biaSaveBusy) {
    alert("Attendi che il salvataggio in corso sia terminato.");
    return false;
  }
  return !state.dirty || confirm("Ci sono modifiche non salvate alla scheda. Vuoi abbandonarle?");
}

function showCoachRoute(route, tab = "overview", historyTarget = "") {
  coachRoute = route;
  directoryTab = tab;
  directoryHistoryTarget = historyTarget;
  $("coachHome").classList.toggle("hidden", route !== "home");
  $("coachWorkspace").classList.toggle("hidden", route !== "clients");
  $("coachPage").classList.toggle("hidden", !["priority", "agenda", "settings"].includes(route));
  $("directoryTitle").textContent = directoryLabels[tab] || "Clienti";
  $("directoryHelp").textContent = tab === "overview" ? "Seleziona un cliente" : "Scegli il cliente da aprire";
  if (route === "clients") $("search").value = "";
  renderClients();
  window.scrollTo(0, 0);
  if (route === "settings") renderCoachSettings();
  if (route === "priority" || route === "agenda") renderCoachSchedule(route);
}

function renderCoachSettings() {
  $("coachPageTitle").textContent = "Impostazioni";
  $("coachPageBody").innerHTML = `<div class="card coach-settings-card"><h3>Account coach</h3><b>${esc(clientName(state.coach || {}))}</b><p class="sub">${esc(state.coach?.email)}</p><div class="bar"><button class="secondary" type="button" data-coach-action="changePassword">Cambia password</button><button class="secondary" type="button" data-coach-action="logout">Esci</button></div></div>`;
}

function programDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? value : "";
}

function formatProgramDate(value) {
  return programDate(value) ? new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)) : "—";
}

function calendarKey(date) {
  return new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

async function renderCoachSchedule(route) {
  const request = ++scheduleRequest;
  const priority = route === "priority";
  $("coachPageTitle").textContent = priority ? "Priorità oggi" : "Agenda";
  $("coachPageBody").innerHTML = '<p class="sub" role="status">Caricamento schede…</p>';
  try {
    const clients = state.clients.filter((client) => client.status === "active");
    const programs = new Map();
    for (let offset = 0; offset < clients.length; offset += 100) {
      const { data, error } = await supabase.from("programs")
        .select("athlete_id,name:program->>nome,legacy_name:program->>name,starts_on:program->>dal,legacy_start:program->>startDate,ends_on:program->>al,legacy_end:program->>endDate")
        .in("athlete_id", clients.slice(offset, offset + 100).map((client) => client.id));
      if (error) throw error;
      for (const row of data) programs.set(row.athlete_id, row);
    }
    if (coachRoute !== route || scheduleRequest !== request) return;
    const now = new Date(), today = calendarKey(now);
    const soon = new Date(now);
    soon.setDate(soon.getDate() + 7);
    const until = calendarKey(soon);
    const items = [];
    for (const client of clients) {
      const program = programs.get(client.id);
      const start = programDate(program?.starts_on || program?.legacy_start);
      const end = programDate(program?.ends_on || program?.legacy_end);
      const name = program?.name || program?.legacy_name || "Scheda pubblicata";
      if (priority) {
        if (!program) items.push({ client, date: "", rank: 1, title: "Scheda da assegnare", name: "Il cliente non ha ancora una scheda pubblicata." });
        else if (end && end < today) items.push({ client, date: end, rank: 0, title: "Scheda scaduta", name });
        else if (end && end <= until) items.push({ client, date: end, rank: 2, title: "Scheda in scadenza", name });
      } else {
        if (start && start >= today) items.push({ client, date: start, rank: 0, title: start === end ? "Inizio e fine" : "Inizio scheda", name });
        if (end && end >= today && end !== start) items.push({ client, date: end, rank: 1, title: "Fine scheda", name });
      }
    }
    items.sort((a, b) => priority ? a.rank - b.rank || a.date.localeCompare(b.date) : a.date.localeCompare(b.date) || a.rank - b.rank);
    $("coachPageBody").innerHTML = items.map(({ client, date, title, name }) => `<button class="coach-schedule-row" type="button" data-schedule-client="${esc(client.id)}"><span class="avatar">${esc(initials(client))}</span><span><b>${esc(clientName(client))}</b><small>${esc(name)}${date ? ` · ${formatProgramDate(date)}` : ""}</small></span><span class="pill">${esc(title)}</span></button>`).join("")
      || `<div class="card"><p class="sub">${priority ? "Nessuna scheda da assegnare o in scadenza nei prossimi 7 giorni." : "Nessun inizio o scadenza per le schede pubblicate."}</p></div>`;
  } catch (error) {
    if (coachRoute !== route || scheduleRequest !== request) return;
    notice($("coachPageBody"), friendlyAuthError(error), true);
  }
}

function renderClients() {
  const term = $("search").value.trim().toLowerCase();
  const filtered = state.clients.filter((client) => `${clientName(client)} ${client.email || ""}`.toLowerCase().includes(term));
  if (state.coach) $("coachClientCount").textContent = `${state.clients.length} ${state.clients.length === 1 ? "cliente" : "clienti"}`;
  $("clientList").innerHTML = filtered.length ? filtered.map((client) => {
    const current = state.selected?.id === client.id;
    return `<button type="button" class="client${current ? " on" : ""}" data-client="${esc(client.id)}"${current ? ' aria-current="page"' : ""}><span class="avatar">${esc(initials(client))}</span><span class="info"><b>${esc(clientName(client))}</b><small>${esc(client.email)}</small></span><span class="pill ${esc(client.status)}">${clientStatus(client)}</span></button>`;
  }).join("") : '<p class="sub">Nessun cliente trovato.</p>';
}
async function loadClients() {
  const clients = [], pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from("profiles").select("*")
      .eq("trainer_id", state.coach.uid).eq("role", "athlete")
      .order("last_name").order("first_name").order("id").range(offset, offset + pageSize - 1);
    if (error) throw error;
    clients.push(...data.map(profileFromRow));
    if (data.length < pageSize) break;
  }
  state.clients = clients;
  if (state.selected && !state.clients.some((client) => client.id === state.selected.id)) clearClientSelection();
  renderClients();
  if (coachRoute === "priority" || coachRoute === "agenda") renderCoachSchedule(coachRoute);
}
function stopDetails() { state.channels.forEach((channel) => supabase.removeChannel(channel)); state.channels = []; }
function watch(table, filter, reload) {
  const channel = supabase.channel(`${table}:${filter}:${crypto.randomUUID()}`).on("postgres_changes", { event: "*", schema: "public", table, filter }, () => reload().catch((e) => alert(friendlyAuthError(e)))).subscribe();
  state.channels.push(channel);
}
async function loadDetails(uid) {
  if (state.selected?.id !== uid) return false;
  const selection = clientSelection;
  const request = ++detailsRequest;
  const [profile, athleteState, program, versions, messages, drafts] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", uid).single(),
    supabase.from("athlete_states").select("*").eq("user_id", uid).maybeSingle(),
    supabase.from("programs").select("*").eq("athlete_id", uid).maybeSingle(),
    supabase.from("program_versions").select("*").eq("athlete_id", uid).order("archived_at", { ascending: false }).limit(20),
    supabase.from("messages").select("*").eq("athlete_id", uid).order("created_at").limit(100),
    supabase.from("program_drafts").select("*").eq("coach_id", state.coach.uid).eq("athlete_id", uid).eq("status", "draft").order("updated_at", { ascending: false }).limit(30)
  ]);
  if (selection !== clientSelection || request < detailsApplied) return false;
  for (const result of [profile, athleteState, program, versions, messages, drafts]) if (result.error) throw result.error;
  detailsApplied = request;
  state.selected = profileFromRow(profile.data); state.snapshot = athleteState.data?.snapshot || {}; state.currentProgram = mapProgram(program.data);
  state.versions = versions.data.map((row) => ({ id: row.id, versionId: row.id, revision: row.revision, program: row.program, publishedAt: row.published_at, archivedAt: row.archived_at })); state.messages = messages.data.map(mapMessage); state.drafts = drafts.data.map(mapDraft);
  const index = state.clients.findIndex((item) => item.id === uid); if (index >= 0) state.clients[index] = state.selected;
  renderClients(); renderDetail(); renderActivity(); renderMessages(); renderVersions(); renderDrafts();
  if (!state.activeDraft && !state.dirty && !programSaveBusy) {
    if (state.drafts.length) loadDraft(state.drafts[0]);
    else resetProgramForm(state.currentProgram?.program || null);
  }
  return true;
}
async function selectClient(uid, tab = directoryTab, target = directoryHistoryTarget) {
  if (state.selected?.id === uid && $("detail").classList.contains("show")) {
    setCoachTab(tab, target);
    return;
  }
  const client = state.clients.find((item) => item.id === uid);
  if (!client || !canLeaveClient()) return;
  clearClientSelection();
  const selection = clientSelection;
  state.selected = client;
  state.snapshot = {}; state.currentProgram = null; state.versions = []; state.messages = []; state.drafts = []; state.activeDraft = null;
  $("coachMessage").value = "";
  resetProgramForm();
  detailStatus("Caricamento cliente…", clientName(client));
  renderClients();
  window.scrollTo(0, 0);
  try {
    if (!await loadDetails(uid) || selection !== clientSelection) return;
    $("empty").classList.add("hidden");
    $("detail").classList.add("show");
    $("coachWorkspace").classList.add("has-client");
    nutrition.select(uid);
    setCoachTab(tab, target);
    const reload = () => loadDetails(uid);
    watch("profiles", `id=eq.${uid}`, reload); watch("athlete_states", `user_id=eq.${uid}`, reload); watch("programs", `athlete_id=eq.${uid}`, reload); watch("program_versions", `athlete_id=eq.${uid}`, reload); watch("messages", `athlete_id=eq.${uid}`, reload); watch("program_drafts", `athlete_id=eq.${uid}`, reload);
  } catch (error) {
    if (selection !== clientSelection) return;
    clearClientSelection();
    detailStatus("Impossibile aprire il cliente", friendlyAuthError(error));
  }
}

function renderDetail() {
  const client = state.selected;
  if (!client) return;
  $("detailAvatar").textContent = initials(client);
  $("detailName").textContent = clientName(client);
  $("detailEmail").textContent = client.email || "";
  $("detailAccess").textContent = clientStatus(client);
  $("detailAccess").className = `pill ${client.status || ""}`;
  if (!$("accessAction").disabled) $("accessAction").textContent = client.status === "suspended" ? "Riattiva accesso" : "Sospendi accesso";
  $("accountSummary").innerHTML = `<div class="metric">${clientStatus(client)}</div><p class="sub">Registrato il ${when(client.createdAt)}<br>Primo accesso ${client.onboardingComplete ? "completato" : "da completare"}</p>`;
  renderOverview();
}
function publishedProgramSummary(program) {
  const start = program.dal || program.startDate;
  const end = program.al || program.endDate;
  const today = calendarKey(new Date());
  let label = "Pubblicata";
  if (programDate(end) && end < today) label = "Scaduta";
  else if (programDate(start) && start > today) label = "In programma";
  return `<span class="pill">${label}</span><div class="metric coach-summary-title">${esc(program.nome || program.name || "Scheda")}</div><p class="sub">${formatProgramDate(start)} → ${formatProgramDate(end)} · versione ${esc(state.currentProgram.revision || 1)}</p>`;
}
function renderOverview() {
  if (!state.selected) return; const program = state.currentProgram?.program;
  $("currentProgramSummary").innerHTML = program ? publishedProgramSummary(program) : '<p class="sub">Nessuna scheda pubblicata.</p>';
  const sessions = Array.isArray(state.snapshot.sessioni) ? state.snapshot.sessioni : []; const lastSession = sessions.slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  $("lastWorkout").innerHTML = lastSession ? `<div class="metric" style="font-size:18px">${esc(lastSession.titolo || "Allenamento")}</div><p class="sub">${when(lastSession.ts)} · ${esc(lastSession.prog || "")}</p>` : `<p class="sub">Nessun allenamento registrato.</p>`;
  const weights = Array.isArray(state.snapshot.pesi) ? state.snapshot.pesi : []; const lastWeight = weights.slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  const lastBia = [...(Array.isArray(state.snapshot.bia) ? state.snapshot.bia : [])].sort((a, b) => Date.parse(b?.measuredAt) - Date.parse(a?.measuredAt))[0];
  const useBia = lastBia?.weightKg != null && (!lastWeight || Date.parse(lastBia.measuredAt) >= Number(lastWeight.ts));
  $("lastWeight").innerHTML = useBia
    ? `<div class="metric">${biaNumber(lastBia.weightKg)} kg</div><p class="sub">BIA · ${when(lastBia.measuredAt)}</p>`
    : lastWeight ? `<div class="metric">${biaNumber(lastWeight.v)} kg</div><p class="sub">Pesata · ${when(lastWeight.ts)}</p>` : '<p class="sub">Nessuna pesata registrata.</p>';
}

const activityNumber = (value) => {
  if (value == null || String(value).trim() === "") return null;
  const result = Number(String(value).replace(",", "."));
  return Number.isFinite(result) ? result : null;
};
const activityFormat = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 2 });

function exerciseTable(exercise) {
  const sets = Array.isArray(exercise.sets) ? exercise.sets.filter(Boolean) : [];
  if (!sets.length) return '<p class="sub">Nessuna serie registrata.</p>';
  const timed = exercise.unita === "sec";
  const unit = exercise.perLato ? "kg/lato" : "kg";
  return `<table class="coach-set-table"><thead><tr><th scope="col">Serie</th><th scope="col">Carico</th><th scope="col">${timed ? "Tempo" : "Rip."}</th><th scope="col">RIR</th></tr></thead><tbody>${sets.map((set, index) => {
    const kg = activityNumber(set.kg), reps = activityNumber(set.reps), rir = activityNumber(set.rir);
    const side = Array.isArray(exercise.lati) && ["DX", "SX"].includes(exercise.lati[index]) ? exercise.lati[index] : "";
    const row = side ? `${Math.ceil((index + 1) / 2)} ${side}` : index + 1;
    return `<tr><th scope="row">${row}</th><td>${kg == null ? "—" : `${activityFormat.format(kg)} ${unit}`}</td><td>${reps == null ? "—" : activityFormat.format(reps) + (timed ? " s" : "")}</td><td>${rir == null ? "—" : activityFormat.format(rir)}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function renderSessionItem(session, index, expanded) {
  const key = String(session.id || `${session.ts || ""}-${index}`);
  const exercises = Array.isArray(session.esercizi) ? session.esercizi.filter(Boolean) : [];
  const setCount = exercises.reduce((total, exercise) => total + (Array.isArray(exercise.sets) ? exercise.sets.filter(Boolean).length : 0), 0);
  const labels = { dolore: "Dolore durante il movimento", fastidio: "Fastidio articolare", carico: "Problema con il carico", tecnica: "Dubbio sull’esecuzione" };
  return `<details class="rowcard coach-history-item" data-session-key="${esc(key)}"${expanded.has(key) ? " open" : ""}>
    <summary><span><b>${esc(session.titolo || "Allenamento")}</b><small>${when(session.ts)}${session.prog ? ` · ${esc(session.prog)}` : ""}</small></span><span class="pill">${setCount} serie</span></summary>
    <div class="coach-history-detail">
      ${session.nota ? `<p class="coach-session-note">${esc(session.nota)}</p>` : ""}
      ${exercises.map((exercise) => `<section class="coach-history-exercise"><h4>${esc(exercise.nome || "Esercizio")}</h4>${exerciseTable(exercise)}${exercise.note ? `<p class="coach-session-note">${esc(exercise.note)}</p>` : ""}${exercise.segnalato ? `<p class="coach-session-flag">Segnalazione · ${esc(labels[exercise.segnalato] || exercise.segnalato)}</p>` : ""}</section>`).join("") || '<p class="sub">Dettagli della seduta non disponibili.</p>'}
    </div>
  </details>`;
}

function renderExerciseLoads(sessions, expanded) {
  const loads = new Map();
  for (const session of sessions) {
    for (const exercise of Array.isArray(session.esercizi) ? session.esercizi : []) {
      const sets = Array.isArray(exercise?.sets) ? exercise.sets.filter(Boolean) : [];
      const name = String(exercise?.nome || "").trim();
      if (!name || !sets.length) continue;
      const key = `${name.toLocaleLowerCase("it-IT")}|${exercise.perLato ? "lato" : ""}|${exercise.unita === "sec" ? "sec" : "reps"}`;
      const item = loads.get(key) || { name, records: [], best: 0 };
      if (item.records.length < 10) item.records.push({ ts: session.ts, exercise });
      for (const set of sets) item.best = Math.max(item.best, activityNumber(set.kg) || 0);
      loads.set(key, item);
    }
  }
  return [...loads.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name, "it")).map(([key, item]) => {
    const latest = item.records[0];
    const best = item.best > 0 ? ` · Max ${activityFormat.format(item.best)} ${latest.exercise.perLato ? "kg/lato" : "kg"}` : "";
    return `<details class="rowcard coach-history-item" data-load-key="${esc(key)}"${expanded.has(key) ? " open" : ""}>
      <summary><span><b>${esc(item.name)}</b><small>Ultima registrazione ${when(latest.ts)}${best}</small></span></summary>
      <div class="coach-history-detail">${item.records.map(({ ts, exercise }) => `<section class="coach-history-exercise"><h4>${when(ts)}</h4>${exerciseTable(exercise)}</section>`).join("")}</div>
    </details>`;
  }).join("") || '<p class="sub">Nessun carico registrato.</p>';
}

function renderActivity() {
  const sessions = (Array.isArray(state.snapshot.sessioni) ? state.snapshot.sessioni : []).filter(Boolean).sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const openSessions = new Set([...$("workoutList").querySelectorAll("details[open]")].map((item) => item.dataset.sessionKey));
  const openLoads = new Set([...$("loadList").querySelectorAll("details[open]")].map((item) => item.dataset.loadKey));
  const sessionMarkup = sessions.slice(0, visibleSessions).map((session, index) => renderSessionItem(session, index, openSessions)).join("");
  $("workoutList").innerHTML = sessionMarkup
    ? sessionMarkup + (sessions.length > visibleSessions ? '<button class="secondary" type="button" data-more-sessions>Mostra altri allenamenti</button>' : "")
    : '<p class="sub">Nessun allenamento registrato.</p>';
  $("loadList").innerHTML = renderExerciseLoads(sessions, openLoads);
  const weights = (Array.isArray(state.snapshot.pesi) ? state.snapshot.pesi : []).filter(Boolean).sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  $("weightList").innerHTML = weights.slice(0, 30).map((item) => `<div class="rowcard"><b>${biaNumber(item.v)} kg</b><small>Peso corporeo · ${when(item.ts)}</small></div>`).join("") || '<p class="sub">Nessuna pesata registrata.</p>';
  const days = Object.entries(state.snapshot.giornate || {}).filter(([, item]) => item).sort(([a], [b]) => b.localeCompare(a));
  $("checkinList").innerHTML = days.slice(0, 30).map(([date, item]) => `<div class="rowcard"><b>${esc(date)}</b><small>Sonno ${esc(item.sonnoOre ?? "—")} h · Energia ${esc(item.energia ?? "—")} · DOMS ${esc(item.doms ?? "—")}</small></div>`).join("") || '<p class="sub">Nessun check-in.</p>';
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
  biaReadRequest += 1;
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
  const save = $("biaSave"); save.disabled = biaSaveBusy || !(allFieldsReady && manualHistory && validation.ready);
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
async function setBiaPreview(canvas, request) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
  if (!blob) throw new Error("Non è stato possibile preparare l’anteprima del referto.");
  if (request !== biaReadRequest) return;
  if (biaPhotoUrl) URL.revokeObjectURL(biaPhotoUrl);
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
    resetBiaUpload();
    const request = biaReadRequest, clientUid = state.selected?.id;
    if (!clientUid) { uploadStatus.textContent = "Seleziona prima un cliente."; uploadStatus.classList.add("error"); return; }
    try {
      const format = await inspectBiaFile(file);
      if (request !== biaReadRequest) return;
      uploadStatus.classList.remove("error"); uploadStatus.textContent = "Lettura locale del referto…";
      const result = await recognizeInBodyPhoto(file, ({ status, progress }) => {
        if (request !== biaReadRequest) return;
        const percent = Number.isFinite(progress) ? ` ${Math.round(progress * 100)}%` : "";
        uploadStatus.textContent = `${status || "Lettura del referto…"}${percent}`;
      });
      if (request !== biaReadRequest) return;
      await setBiaPreview(result.preview, request);
      if (request !== biaReadRequest) return;
      pendingBia = result;
      pendingBia.fileType = format.type;
      pendingBiaFile = file;
      biaSourceClientUid = clientUid;
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
    } catch (error) {
      if (request !== biaReadRequest) return;
      resetBiaUpload();
      uploadStatus.textContent = error.message || "Non è stato possibile leggere il referto.";
      uploadStatus.classList.add("error");
    }
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
    if (biaSaveBusy) return;
    const button = $("biaSave"), clientUid = biaSourceClientUid, file = pendingBiaFile, bia = pendingBia;
    const selection = clientSelection;
    biaSaveBusy = true;
    $("biaPhotoInput").disabled = true;
    $("biaChoosePhoto").disabled = true;
    $("biaCancelReview").disabled = true;
    setBusy(button, true, "Salvataggio…"); $("biaReviewStatus").textContent = "Conservo il referto e salvo la rilevazione…"; $("biaReviewStatus").classList.remove("error");
    let reportPath = null, reportPreviewPath = null, persistenceStarted = false, recordWritten = false;
    try {
      const extension = biaArchiveExtensions[bia.fileType];
      if (!extension) throw new Error("Tipo di file originale non supportato per l’archivio privato.");
      const reportUid = crypto.randomUUID(); reportPath = `${clientUid}/${reportUid}.${extension}`; reportPreviewPath = `${clientUid}/${reportUid}-preview.jpg`;
      const { error: uploadError } = await supabase.storage.from("bia-reports").upload(reportPath, file, { upsert: false, contentType: bia.fileType, cacheControl: "0" });
      if (uploadError) throw uploadError;
      const previewBlob = await makeBiaArchivePreview(bia.preview);
      const { error: previewError } = await supabase.storage.from("bia-reports").upload(reportPreviewPath, previewBlob, { upsert: false, contentType: "image/jpeg", cacheControl: "0" });
      if (previewError) throw previewError;
      const values = reviewed.values;
      const sourceAudit = {
        fields: Object.fromEntries(requiredBiaFields.map((key) => {
          const field = bia.fields?.[key] || {};
          return [key, { status: "ok", source: field.source === "corretto_manualmente" ? "corretto_manualmente" : "verificato_dal_pt", confidence: 1, bbox: field.bbox || null }];
        })),
        confirmation: reviewed.confirmation
      };
      const payload = {
        clientUid, measuredAt: measuredIso,
        weightKg: values.weightKg, bodyFatMassKg: values.bodyFatMassKg, skeletalMuscleKg: values.skeletalMuscleKg,
        reportId: bia.fields?.reportId?.value || null, device: "InBody120", reportPath, reportPreviewPath, sourceAudit
      };
      persistenceStarted = true;
      const result = await calls.recordBia(payload);
      recordWritten = true;
      const { data: persisted, error: verifyError } = await supabase.from("athlete_states").select("snapshot, revision").eq("user_id", clientUid).maybeSingle();
      if (verifyError) throw new Error(`BIA salvata, ma verifica database non riuscita: ${friendlyAuthError(verifyError)}`);
      const persistedRecords = Array.isArray(persisted?.snapshot?.bia) ? persisted.snapshot.bia : [];
      if (!persistedRecords.some((item) => item.id === result.record?.id)) throw new Error("BIA non trovata nel database dopo il salvataggio. Ricarica lo storico prima di riprovare.");
      if (selection !== clientSelection) return;
      state.snapshot = persisted.snapshot; renderActivity(); renderOverview(); resetBiaUpload(); uploadStatus.textContent = "Referto BIA salvato nel database. Foto, valori e grafici resteranno disponibili dopo il ricaricamento.";
    } catch (error) {
      const uploadedPaths = [reportPath, reportPreviewPath].filter(Boolean);
      if (uploadedPaths.length && !recordWritten) {
        let referenced = persistenceStarted;
        if (persistenceStarted) {
          try {
            const { data, error: readError } = await supabase.from("athlete_states").select("snapshot").eq("user_id", clientUid).maybeSingle();
            if (!readError) referenced = (data?.snapshot?.bia || []).some((item) => uploadedPaths.includes(item.reportPath) || uploadedPaths.includes(item.reportPreviewPath));
          } catch { /* Keep the files if the server could not confirm they are unused. */ }
        }
        if (!referenced) {
          try { await supabase.storage.from("bia-reports").remove(uploadedPaths); }
          catch { /* Preserve the original save error. */ }
        }
      }
      if (selection === clientSelection) {
        const status = $("biaReviewStatus"); status.textContent = friendlyAuthError(error); status.classList.add("error");
      }
    } finally {
      biaSaveBusy = false;
      $("biaPhotoInput").disabled = false;
      $("biaChoosePhoto").disabled = false;
      $("biaCancelReview").disabled = false;
      setBusy(button, false);
      updateBiaReview();
    }
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
  if (invalid) {
    for (let node = invalid.parentElement; node && node !== $("programEditor"); node = node.parentElement) {
      if (node.tagName === "DETAILS") node.open = true;
    }
    invalid.focus();
    throw new Error(invalid.validationMessage || "Correggi i campi evidenziati in rosso prima di salvare.");
  }
  const program = programBuilder.getProgram();
  program.nome = $("programName").value.trim(); program.dal = $("programStart").value; program.al = $("programEnd").value; program.schemaVersion = 2;
  const result = validateV2Program(program);
  if (!result.valid) { const first = result.errors[0]; throw new Error(`${first.path}: ${first.message}`); }
  return result.program;
}
function loadDraft(draft) {
  if (!draft || programSaveBusy) return;
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
  const version = findVersion(versionId), clientUid = state.selected?.id, selection = clientSelection;
  if (!version || !clientUid || programSaveBusy) return;
  const stats = versionMetrics(version.program);
  if (state.dirty && !confirm("Ci sono modifiche non salvate. Ripristinare la versione le abbandonerà e creerà una nuova bozza. Continuare?")) return;
  if (!confirm(`Ripristinare la versione ${version.revision || 1} come nuova bozza? La versione attiva resterà invariata.\n\n${stats.weeks} settimane · ${stats.sessions} sedute · ${stats.sets} serie utili`)) return;
  clearTimeout(programAutosaveTimer);
  programSaveBusy = true;
  try {
    const response = await calls.saveProgramDraft({ clientUid, draftId: null, expectedRevision: 0, program: convertLegacyProgram(version.program) });
    if (selection !== clientSelection) return;
    state.activeDraft = null; state.dirty = false; await loadDetails(clientUid);
    if (selection !== clientSelection) return;
    programSaveBusy = false;
    const draft = state.drafts.find((item) => item.id === response.draftId);
    if (draft) loadDraft(draft);
    notice($("programNotice"), `Versione ripristinata come bozza · revisione ${response.revision}. La versione attiva non è stata modificata.`);
  } catch (error) { if (selection === clientSelection) notice($("programNotice"), friendlyAuthError(error), true); }
  finally { programSaveBusy = false; if (state.dirty) scheduleProgramAutosave(); }
}
async function archiveDraftById(draftId) {
  const clientUid = state.selected?.id, selection = clientSelection;
  const draft = state.drafts.find((item) => item.id === draftId);
  if (!clientUid || programSaveBusy || !draft || !confirm(`Archiviare la bozza “${draft.program?.nome || "Senza nome"}”? I dati restano conservati.`)) return;
  if (state.activeDraft?.id === draftId && state.dirty && !confirm("La bozza contiene modifiche non salvate. Archiviandola, queste ultime modifiche non verranno conservate. Continuare?")) return;
  clearTimeout(programAutosaveTimer);
  programSaveBusy = true;
  try {
    await calls.archiveProgramDraft({ draftId });
    if (selection !== clientSelection) return;
    const wasActive = state.activeDraft?.id === draftId;
    if (wasActive) { state.activeDraft = null; state.dirty = false; }
    await loadDetails(clientUid);
    if (selection !== clientSelection) return;
    if (wasActive && !state.dirty) {
      programSaveBusy = false;
      const next = state.drafts.find((item) => item.id !== draftId);
      if (next) loadDraft(next);
      else resetProgramForm(state.currentProgram?.program || null);
    }
    notice($("programNotice"), "Bozza archiviata; i dati sono conservati.");
  } catch (error) { if (selection === clientSelection) notice($("programNotice"), friendlyAuthError(error), true); }
  finally { programSaveBusy = false; if (state.dirty) scheduleProgramAutosave(); }
}
async function saveDraft({ autosave = false } = {}) {
  if (!state.selected) throw new Error("Seleziona un cliente.");
  const clientUid = state.selected.id, selection = clientSelection, editVersion = programEditVersion, program = formProgram();
  const response = await calls.saveProgramDraft({ clientUid, draftId: state.activeDraft?.id || null, expectedRevision: state.activeDraft?.revision || 0, program });
  const { data, error } = await supabase.from("program_drafts").select("*").eq("id", response.draftId).eq("coach_id", state.coach.uid).eq("athlete_id", clientUid).single();
  if (error) throw error;
  if (Number(data.revision) !== Number(response.revision) || data.status !== "draft" || !sameProgram(data.program, program)) throw new Error("La bozza è stata inviata ma non coincide con i dati riletti dal database. Riapri la bozza e verifica le modifiche.");
  if (selection !== clientSelection || state.selected?.id !== clientUid) throw new Error("Il cliente della bozza non è più aperto.");
  state.activeDraft = mapDraft(data); state.drafts = [state.activeDraft, ...state.drafts.filter((item) => item.id !== state.activeDraft.id)]; renderDrafts();
  if (editVersion === programEditVersion) { state.dirty = false; programStatusLabel("Bozza"); saveStateLabel(`Salvato alle ${new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`); }
  else { state.dirty = true; scheduleProgramAutosave(); }
  if (!autosave) notice($("programNotice"), `Bozza verificata nel database · revisione ${response.revision}. Per renderla visibile al cliente premi “Pubblica”.`);
  return state.activeDraft;
}
async function downloadExport() {
  const client = state.selected, selection = clientSelection;
  if (!client) return;
  const [response, nutritionResult] = await Promise.all([
    calls.exportClientData({ clientUid: client.id }),
    supabase.from("nutrition_plans").select("*").eq("athlete_id", client.id).order("status")
  ]);
  if (selection !== clientSelection) return;
  if (nutritionResult.error) throw new Error(`Impossibile completare l’esportazione dei consigli alimentari. ${friendlyAuthError(nutritionResult.error)}`);
  const blob = new Blob([JSON.stringify({ ...response, nutritionPlans: nutritionResult.data }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url;
  link.download = `lippolis-${client.lastName || "cliente"}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

document.querySelectorAll("[data-coach-route]").forEach((button) => button.addEventListener("click", () => {
  if (!canLeaveClient()) return;
  clearClientSelection();
  showCoachRoute(button.dataset.coachRoute, button.dataset.clientTab, button.dataset.historyTarget);
}));
$("coachPageBody").addEventListener("click", (event) => {
  const action = event.target.closest("[data-coach-action]");
  if (action) $(action.dataset.coachAction)?.click();
  const client = event.target.closest("[data-schedule-client]");
  if (!client || !canLeaveClient()) return;
  clearClientSelection();
  showCoachRoute("clients", "program");
  selectClient(client.dataset.scheduleClient);
});
$("clientList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-client]");
  if (button) selectClient(button.dataset.client);
});
$("backClients").addEventListener("click", () => {
  if (!canLeaveClient()) return;
  clearClientSelection();
  $("search").focus();
});
document.querySelectorAll(".tabs [data-tab], [data-open-tab]").forEach((button) => {
  button.addEventListener("click", () => setCoachTab(button.dataset.tab || button.dataset.openTab, button.dataset.historyTarget));
});
$("workoutList").addEventListener("click", (event) => {
  if (!event.target.closest("[data-more-sessions]")) return;
  visibleSessions += 30;
  renderActivity();
});
$("search").addEventListener("input", renderClients); $("addClient").addEventListener("click", () => { $("addForm").classList.remove("hidden"); $("createdResult").classList.add("hidden"); $("addForm").reset(); generatePassword(); notice($("addNotice"), ""); openModal("addModal"); }); $("generatePassword").addEventListener("click", generatePassword);
$("addForm").addEventListener("submit", async (event) => { event.preventDefault(); const button = $("createClient"); setBusy(button, true, "Creazione…"); notice($("addNotice"), ""); const password = $("clientPassword").value; try { const response = await calls.createClient({ firstName: $("clientFirst").value, lastName: $("clientLast").value, email: $("clientEmail").value, password, idempotencyKey: randomKey() }); $("createdCredentials").textContent = `${response.email}\n${password}`; $("addForm").classList.add("hidden"); $("createdResult").classList.remove("hidden"); await loadClients(); } catch (error) { notice($("addNotice"), friendlyAuthError(error), true); } finally { setBusy(button, false); } });
$("accessAction").addEventListener("click", async () => {
  const client = state.selected;
  if (!client) return;
  const action = client.status === "suspended" ? "reactivate" : "suspend";
  if (action === "suspend" && !confirm(`Sospendere immediatamente l’accesso di ${clientName(client)}? I dati saranno conservati.`)) return;
  const button = $("accessAction");
  button.disabled = true;
  button.textContent = "Attendi…";
  try {
    await calls.setClientAccess({ clientUid: client.id, action });
    await loadDetails(client.id);
  } catch (error) {
    alert(friendlyAuthError(error));
  } finally {
    button.disabled = false;
    renderDetail();
  }
});
$("exportClient").addEventListener("click", () => downloadExport().catch((error) => alert(friendlyAuthError(error)))); $("deleteClient").addEventListener("click", () => { $("deletePrompt").textContent = `Stai eliminando ${state.selected.firstName} ${state.selected.lastName} (${state.selected.email}). Account e dati esclusivi saranno rimossi.`; $("deleteConfirmation").value = ""; notice($("deleteNotice"), ""); openModal("deleteModal"); }); $("exportBeforeDelete").addEventListener("click", () => downloadExport().catch((error) => notice($("deleteNotice"), friendlyAuthError(error), true)));
$("confirmDelete").addEventListener("click", async () => {
  const clientUid = state.selected?.id;
  if (!clientUid || programSaveBusy) return;
  const button = $("confirmDelete");
  setBusy(button, true, "Eliminazione…");
  try {
    await calls.deleteClient({ clientUid, confirmationEmail: $("deleteConfirmation").value.trim() });
    closeModal("deleteModal");
    if (state.selected?.id === clientUid) clearClientSelection();
    await loadClients();
  } catch (error) {
    notice($("deleteNotice"), friendlyAuthError(error), true);
  } finally {
    setBusy(button, false);
  }
});
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
  if (programSaveBusy) return;
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
$("newDraft").addEventListener("click", () => { if (programSaveBusy || (state.dirty && !confirm("Scartare la scheda corrente e crearne una nuova?"))) return; clearTimeout(programAutosaveTimer); resetProgramForm(); });
$("duplicateDraft").addEventListener("click", () => {
  if (programSaveBusy) return;
  if (state.dirty && !confirm("Duplicare la versione corrente e scartare le modifiche non salvate?")) return;
  clearTimeout(programAutosaveTimer); state.activeDraft = null; loadingProgram = true; const copy = programBuilder.duplicate(); $("programName").value = copy.nome; loadingProgram = false; programChanged(); notice($("programNotice"), "Copia indipendente pronta. Il salvataggio automatico la conserverà come nuova bozza.");
});
$("saveDraft").addEventListener("click", async () => { if (programSaveBusy) return notice($("programNotice"), "È già in corso un salvataggio.", true); clearTimeout(programAutosaveTimer); const button = $("saveDraft"); setBusy(button, true, "Salvataggio…"); programSaveBusy = true; saveStateLabel("Salvataggio…"); try { await saveDraft(); } catch (error) { saveStateLabel("Errore: riprova", "error"); notice($("programNotice"), friendlyAuthError(error), true); } finally { programSaveBusy = false; setBusy(button, false); } });
$("publishProgram").addEventListener("click", async () => {
  if (programSaveBusy) return notice($("programNotice"), "Attendi che il salvataggio della bozza sia terminato.", true);
  const button = $("publishProgram"), clientUid = state.selected?.id, selection = clientSelection;
  if (!clientUid) return;
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
  clearTimeout(programAutosaveTimer);
  programSaveBusy = true;
  $("programEditor").inert = true;
  $("programJsonPanel").inert = true;
  for (const input of [$("programName"), $("programStart"), $("programEnd")]) input.disabled = true;
  setBusy(button, true, "Pubblicazione…");
  let draft = state.activeDraft;
  try {
    if (state.dirty || !draft || !sameProgram(draft.program, draftProgram)) draft = await saveDraft();
    if (selection !== clientSelection) return;
    const response = await calls.publishProgram({ clientUid, draftId: draft.id, expectedRevision: draft.revision });
    if (selection !== clientSelection) return;
    state.activeDraft = null;
    state.dirty = false;
    const { data, error } = await supabase.from("programs").select("*").eq("athlete_id", clientUid).single(); if (error) throw error;
    if (data.version_id !== response.versionId || !sameProgram(data.program, draft.program)) throw new Error("Pubblicazione non verificata nel database. Ricarica la scheda e controlla la versione attiva.");
    if (selection !== clientSelection) return;
    state.currentProgram = mapProgram(data);
    renderOverview();
    await loadDetails(clientUid);
    if (selection !== clientSelection) return;
    notice($("programNotice"), `Scheda pubblicata e verificata · il cliente la vede in Workout · versione ${response.versionId}`); programStatusLabel(publishedLabel()); saveStateLabel("Pubblicata e verificata");
  } catch (error) {
    if (selection === clientSelection) {
      if (!state.activeDraft) await loadDetails(clientUid).catch(() => {});
      if (selection === clientSelection) {
        notice($("programNotice"), friendlyAuthError(error), true);
        saveStateLabel("Errore: riprova", "error");
      }
    }
  } finally {
    programSaveBusy = false;
    $("programEditor").inert = false;
    $("programJsonPanel").inert = false;
    for (const input of [$("programName"), $("programStart"), $("programEnd")]) input.disabled = false;
    setBusy(button, false);
    if (state.dirty) scheduleProgramAutosave();
  }
});
$("archiveDraft").addEventListener("click", async () => { if (!state.activeDraft) return notice($("programNotice"), "Carica prima una bozza.", true); return archiveDraftById(state.activeDraft.id); });
$("importProgram").addEventListener("click", () => { if (!programSaveBusy) $("importProgramFile").click(); }); $("importProgramFile").addEventListener("change", async () => {
  const file = $("importProgramFile").files[0], selection = clientSelection;
  if (!file || programSaveBusy) return;
  try {
    const parsed = JSON.parse(await file.text()), source = Array.isArray(parsed) ? { settimane: parsed } : parsed.PROGRAMMA || parsed.program || parsed;
    if (selection !== clientSelection || programSaveBusy) return;
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
  } catch (error) { if (selection === clientSelection) { loadingProgram = false; notice($("programNotice"), friendlyAuthError(error), true); } }
  finally { $("importProgramFile").value = ""; }
});
$("sendMessage").addEventListener("click", async () => {
  const input = $("coachMessage"), original = input.value, text = original.trim();
  const clientUid = state.selected?.id, selection = clientSelection;
  if (!text || !clientUid) return;
  const button = $("sendMessage");
  setBusy(button, true, "Invio…");
  try {
    const { error } = await supabase.from("messages").insert({ athlete_id: clientUid, sender_id: state.coach.uid, target_id: clientUid, channel: "thread", text });
    if (error) throw error;
    if (selection === clientSelection && input.value === original) input.value = "";
  } catch (error) {
    alert(friendlyAuthError(error));
  } finally {
    setBusy(button, false);
  }
});
$("printBia").addEventListener("click", () => window.print());
setupBiaUpload();
$("changePassword").addEventListener("click", () => { $("currentPassword").value = ""; $("coachNewPassword").value = ""; notice($("passwordNotice"), ""); openModal("passwordModal"); }); $("savePassword").addEventListener("click", async () => { const button = $("savePassword"); setBusy(button, true); try { const { error: authError } = await supabase.auth.signInWithPassword({ email: state.coach.email, password: $("currentPassword").value }); if (authError) throw authError; if ($("coachNewPassword").value.length < 12) throw new Error("La nuova password deve contenere almeno 12 caratteri."); const { error } = await supabase.auth.updateUser({ password: $("coachNewPassword").value }); if (error) throw error; notice($("passwordNotice"), "Password aggiornata."); } catch (error) { notice($("passwordNotice"), friendlyAuthError(error), true); } finally { setBusy(button, false); } });
$("logout").addEventListener("click", () => { if (canLeaveClient()) logout(); });
window.addEventListener("beforeunload", (event) => {
  if (!state.dirty && !programSaveBusy && !biaSaveBusy) return;
  event.preventDefault();
  event.returnValue = "";
});

if (!supabaseConfigured) { alert("Configura Supabase in supabase-config.js."); location.replace("index.html"); }
else {
  const session = await getAuthorizedSession({ requireRole: "coach" });
  if (session.reason) {
    alert(session.reason);
    location.replace("index.html");
  } else {
    state.coach = { uid: session.user.uid, ...session.profile };
    $("coachIdentity").textContent = clientName(state.coach);
    $("coachAvatar").textContent = initials(state.coach);
    if (state.coach.firstName) $("coachGreeting").textContent = `Ciao, ${state.coach.firstName}`;
    await loadClients();
    supabase.channel(`clients:${state.coach.uid}`).on("postgres_changes", { event: "*", schema: "public", table: "profiles", filter: `trainer_id=eq.${state.coach.uid}` }, () => loadClients().catch(() => {})).subscribe();
  }
}
