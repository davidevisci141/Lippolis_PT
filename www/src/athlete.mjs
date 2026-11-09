import { supabase, supabaseConfigured } from "./supabase.mjs";
import { friendlyAuthError, getAuthorizedSession, logout } from "./auth.mjs";
import { recognizeInBodyPhoto } from "./bia-ocr.mjs";

window.lippolisBiaOcr = { recognize: recognizeInBodyPhoto };

const api = window.lippolisAthleteApi;
const badge = document.getElementById("syncBadge");
let knownRevision = 0;
let knownProgramVersion = "";
let cloudReady = false;
let pendingSnapshot = null;
let saving = false;
let saveTimer = null;

function badgeText(text, isError = false) {
  if (!badge) return; badge.textContent = text; badge.style.background = isError ? "#b83d35" : ""; badge.classList.add("show");
  clearTimeout(badgeText.timer); badgeText.timer = setTimeout(() => badge.classList.remove("show"), isError ? 4500 : 1400);
}
function localData() { try { return JSON.parse(localStorage.getItem(api.storageKey) || "null") || api.snapshot(); } catch { return api.snapshot(); } }
function saveLocal(data) { localStorage.setItem(api.storageKey, JSON.stringify({ ...data, salvato: Number(data.salvato || Date.now()) })); }
function sanitizeSnapshot(value) { const clean = structuredClone(value || {}); delete clean.PROGRAMMA; delete clean.thread; delete clean.diario; delete clean.differite; delete clean.app; delete clean.esportato; clean.v = 1; return clean; }
function mergeRemote(remoteState, currentProgram, profile) {
  const local = localData(); const merged = { ...local, ...(remoteState || {}) }; if (currentProgram?.program) merged.PROGRAMMA = currentProgram.program;
  merged.profilo = { ...(merged.profilo || {}), nome: profile.firstName || merged.profilo?.nome || "", cognome: profile.lastName || merged.profilo?.cognome || "" };
  merged.salvato = Math.max(Number(merged.salvato || 0), Date.now()); return merged;
}
async function loadMessages(uid) {
  const { data, error } = await supabase.from("messages").select("*").eq("athlete_id", uid).order("created_at").limit(200); if (error) throw error;
  api.applyMessages(data.map((item) => ({ id: item.id, ts: new Date(item.created_at).getTime(), from: item.sender_id === uid ? "atleta" : "coach", tipo: item.type || "messaggio", testo: item.text, meta: item.metadata || null, channel: item.channel || "thread", letto: true })));
}
async function bootstrap(session) {
  if (!api) throw new Error("Area atleta non inizializzata."); const { user, profile } = session; const storedUid = sessionStorage.getItem("lippolis_uid");
  if (storedUid !== user.uid) { sessionStorage.setItem("lippolis_uid", user.uid); location.reload(); return false; }
  window.__LIPPOLIS_PROFILE__ = profile;
  const identity = document.getElementById("athleteIdentity");
  if (identity) {
    const name = document.createElement("b"); name.textContent = profile.displayName || `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || profile.email || user.email || "Cliente";
    const email = document.createElement("span"); email.textContent = profile.email || user.email || "";
    identity.replaceChildren(name, email);
  }
  const [stateResult, programResult] = await Promise.all([
    supabase.from("athlete_states").select("*").eq("user_id", user.uid).maybeSingle(),
    supabase.from("programs").select("*").eq("athlete_id", user.uid).maybeSingle()
  ]);
  if (stateResult.error) throw stateResult.error; if (programResult.error) throw programResult.error;
  const stateDoc = stateResult.data; const programDoc = programResult.data ? { ...programResult.data, versionId: programResult.data.version_id } : null;
  knownRevision = Number(stateDoc?.revision || 0); knownProgramVersion = programDoc?.versionId || ""; window.__LIPPOLIS_PROGRAM_VERSION__ = knownProgramVersion;
  const markerKey = `lippolis_cloud_boot_${user.uid}`; const marker = `${knownRevision}:${knownProgramVersion}`;
  if (sessionStorage.getItem(markerKey) !== marker) { saveLocal(mergeRemote(stateDoc?.snapshot, programDoc, profile)); sessionStorage.setItem(markerKey, marker); location.reload(); return false; }

  window.lippolisAccount = {
    // Lo snapshot è già salvato localmente; il logout non deve attendere la rete.
    logout: () => logout(),
    updateProfile: async (value) => {
      const first = String(value.nome || "").trim(); const last = String(value.cognome || "").trim();
      const displayName = `${first} ${last}`.trim();
      const { data, error } = await supabase.from("profiles").update({ first_name: first, last_name: last, display_name: displayName, updated_at: new Date().toISOString() }).eq("id", user.uid).select("id, first_name, last_name, display_name").single();
      if (error) throw error;
      if (!data || data.id !== user.uid) throw new Error("Il profilo non è stato aggiornato. Ricarica la pagina e riprova.");
      window.__LIPPOLIS_PROFILE__ = { ...profile, firstName: data.first_name, lastName: data.last_name, displayName: data.display_name };
      const identityName = document.querySelector("#athleteIdentity b");
      if (identityName) identityName.textContent = data.display_name || `${data.first_name} ${data.last_name}`.trim();
      return window.__LIPPOLIS_PROFILE__;
    },
    changePassword: () => window.lippolisOpenPassword?.()
  };

  const savePasswordButton = document.getElementById("athleteSavePassword");
  savePasswordButton?.addEventListener("click", async () => {
    const current = document.getElementById("athleteCurrentPassword").value;
    const next = document.getElementById("athleteNewPassword").value;
    const confirmNext = document.getElementById("athleteConfirmPassword").value;
    const feedback = document.getElementById("athletePasswordFeedback");
    const showFeedback = (message, error = false) => { feedback.textContent = message; feedback.className = `password-feedback show${error ? " error" : ""}`; };
    if (!current) return showFeedback("Inserisci la password attuale.", true);
    if (next.length < 12) return showFeedback("La nuova password deve contenere almeno 12 caratteri.", true);
    if (next !== confirmNext) return showFeedback("Le nuove password non coincidono.", true);
    savePasswordButton.disabled = true; savePasswordButton.textContent = "Aggiornamento…";
    try {
      const { error: loginError } = await supabase.auth.signInWithPassword({ email: user.email, password: current });
      if (loginError) throw loginError;
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) throw error;
      showFeedback("Password aggiornata.");
      document.getElementById("athleteCurrentPassword").value = "";
      document.getElementById("athleteNewPassword").value = "";
      document.getElementById("athleteConfirmPassword").value = "";
    } catch (error) {
      showFeedback(friendlyAuthError(error), true);
    } finally {
      savePasswordButton.disabled = false; savePasswordButton.textContent = "Aggiorna password";
    }
  });

  window.lippolisCloudSync = {
    queue(snapshot) { pendingSnapshot = sanitizeSnapshot(snapshot); if (!cloudReady) return; clearTimeout(saveTimer); saveTimer = setTimeout(() => flush(user.uid), 850); },
    async sendMessage(message, channel) {
      const text = String(message?.testo || "").trim(); if (!text) return;
      try { const { error } = await supabase.from("messages").insert({ athlete_id: user.uid, sender_id: user.uid, target_id: user.uid, channel, type: String(message.tipo || "message").slice(0, 40), text: text.slice(0, 4000), metadata: message.meta || null }); if (error) throw error; }
      catch (error) { badgeText(friendlyAuthError(error), true); }
    }
  };

  supabase.channel(`athlete-state:${user.uid}`).on("postgres_changes", { event: "*", schema: "public", table: "athlete_states", filter: `user_id=eq.${user.uid}` }, (payload) => {
    const value = payload.new || {}; const revision = Number(value.revision || 0); if (revision <= knownRevision) return;
    if (saving || pendingSnapshot) return badgeText("Conflitto: dati aggiornati su un altro dispositivo", true);
    knownRevision = revision; saveLocal(mergeRemote(value.snapshot, null, profile)); sessionStorage.setItem(markerKey, `${knownRevision}:${knownProgramVersion}`); location.reload();
  }).subscribe();
  supabase.channel(`athlete-profile:${user.uid}`).on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${user.uid}` }, async (payload) => {
    if (payload.new?.status === "active") return;
    await supabase.auth.signOut(); alert("Il tuo accesso non è più attivo."); location.replace("index.html");
  }).subscribe();
  supabase.channel(`athlete-program:${user.uid}`).on("postgres_changes", { event: "*", schema: "public", table: "programs", filter: `athlete_id=eq.${user.uid}` }, (payload) => {
    const value = payload.new || null; const version = value?.version_id || ""; if (version === knownProgramVersion) return;
    if (pendingSnapshot) return badgeText("Nuova scheda disponibile: salva o ricarica", true);
    knownProgramVersion = version; window.__LIPPOLIS_PROGRAM_VERSION__ = version; saveLocal(mergeRemote(null, value, profile)); sessionStorage.setItem(markerKey, `${knownRevision}:${knownProgramVersion}`); location.reload();
  }).subscribe();
  supabase.channel(`athlete-messages:${user.uid}`).on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `athlete_id=eq.${user.uid}` }, () => loadMessages(user.uid).catch((error) => badgeText(friendlyAuthError(error), true))).subscribe();
  await loadMessages(user.uid); cloudReady = true; if (pendingSnapshot) flush(user.uid); else if (!stateDoc) window.lippolisCloudSync.queue(api.snapshot()); return true;
}

async function flush(uid) {
  if (!cloudReady || saving || !pendingSnapshot) return; const snapshot = pendingSnapshot; pendingSnapshot = null; saving = true; badgeText("Sincronizzazione…");
  try { const { data, error } = await supabase.rpc("save_athlete_state", { p_expected_revision: knownRevision, p_snapshot: snapshot }); if (error) throw error; knownRevision = Number(data); badgeText("Salvato e sincronizzato"); }
  catch (error) { pendingSnapshot = snapshot; badgeText(error.code === "40001" || /STATE_CONFLICT/.test(error.message) ? "Conflitto: ricarica prima di continuare" : "Offline: salvataggio locale in attesa", true); }
  finally { saving = false; }
}

window.addEventListener("online", async () => { const { data: { session } } = await supabase.auth.getSession(); if (pendingSnapshot && session?.user) flush(session.user.id); });
if (!supabaseConfigured) { alert("Configura Supabase in supabase-config.js."); location.replace("index.html"); }
else { const session = await getAuthorizedSession({ requireRole: "athlete" }); if (session.reason) { alert(session.reason); location.replace("index.html"); } else bootstrap(session).catch((error) => { alert(friendlyAuthError(error)); location.replace("index.html"); }); }
