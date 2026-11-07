import { auth, db, firebaseConfigured } from "./firebase.mjs";
import { friendlyAuthError, getAuthorizedSession, logout } from "./auth.mjs";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const api = window.lippolisAthleteApi;
const badge = document.getElementById("syncBadge");
let knownRevision = 0;
let knownProgramVersion = "";
let cloudReady = false;
let pendingSnapshot = null;
let saving = false;
let saveTimer = null;

function badgeText(text, isError = false) {
  if (!badge) return;
  badge.textContent = text;
  badge.style.background = isError ? "#b83d35" : "";
  badge.classList.add("show");
  clearTimeout(badgeText.timer);
  badgeText.timer = setTimeout(() => badge.classList.remove("show"), isError ? 4500 : 1400);
}

function localData() {
  try { return JSON.parse(localStorage.getItem(api.storageKey) || "null") || api.snapshot(); }
  catch { return api.snapshot(); }
}

function saveLocal(data) {
  localStorage.setItem(api.storageKey, JSON.stringify({ ...data, salvato: Number(data.salvato || Date.now()) }));
}

function sanitizeSnapshot(value) {
  const clean = structuredClone(value || {});
  delete clean.PROGRAMMA;
  delete clean.thread;
  delete clean.diario;
  delete clean.differite;
  delete clean.app;
  delete clean.esportato;
  clean.v = 1;
  return clean;
}

function mergeRemote(remoteState, currentProgram, profile) {
  const local = localData();
  const merged = { ...local, ...(remoteState || {}) };
  if (currentProgram?.program) merged.PROGRAMMA = currentProgram.program;
  merged.profilo = {
    ...(merged.profilo || {}),
    nome: profile.firstName || merged.profilo?.nome || "",
    cognome: profile.lastName || merged.profilo?.cognome || ""
  };
  merged.salvato = Math.max(Number(merged.salvato || 0), Date.now());
  return merged;
}

async function bootstrap(session) {
  if (!api) throw new Error("Area atleta non inizializzata.");
  const { user, profile } = session;
  const storedUid = sessionStorage.getItem("lippolis_uid");
  if (storedUid !== user.uid) {
    sessionStorage.setItem("lippolis_uid", user.uid);
    location.reload();
    return false;
  }
  window.__LIPPOLIS_PROFILE__ = profile;

  const stateRef = doc(db, "profiles", user.uid, "state", "app");
  const programRef = doc(db, "profiles", user.uid, "program", "current");
  const [stateSnap, programSnap] = await Promise.all([getDoc(stateRef), getDoc(programRef)]);
  const stateDoc = stateSnap.exists() ? stateSnap.data() : null;
  const programDoc = programSnap.exists() ? programSnap.data() : null;
  knownRevision = Number(stateDoc?.revision || 0);
  knownProgramVersion = programDoc?.versionId || "";
  window.__LIPPOLIS_PROGRAM_VERSION__ = knownProgramVersion;

  const markerKey = `lippolis_cloud_boot_${user.uid}`;
  const marker = `${knownRevision}:${knownProgramVersion}`;
  if (sessionStorage.getItem(markerKey) !== marker) {
    saveLocal(mergeRemote(stateDoc?.snapshot, programDoc, profile));
    sessionStorage.setItem(markerKey, marker);
    location.reload();
    return false;
  }

  window.lippolisAccount = {
    logout: async () => { try { if (pendingSnapshot) await flush(user.uid, stateRef); } catch {} await logout(); },
    updateProfile: async (value) => updateDoc(doc(db, "profiles", user.uid), {
      firstName: String(value.nome || "").trim(),
      lastName: String(value.cognome || "").trim(),
      displayName: `${String(value.nome || "").trim()} ${String(value.cognome || "").trim()}`.trim(),
      updatedAt: serverTimestamp()
    }),
    changePassword: async () => {
      const current = prompt("Password attuale:"); if (!current) return;
      const next = prompt("Nuova password (almeno 12 caratteri):"); if (!next) return;
      const confirmNext = prompt("Ripeti la nuova password:");
      if (next !== confirmNext) return alert("Le password non coincidono.");
      if (next.length < 12) return alert("La password deve contenere almeno 12 caratteri.");
      try {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
        await updatePassword(user, next);
        alert("Password aggiornata.");
      } catch (error) { alert(friendlyAuthError(error)); }
    }
  };

  window.lippolisCloudSync = {
    queue(snapshot) {
      pendingSnapshot = sanitizeSnapshot(snapshot);
      if (!cloudReady) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flush(user.uid, stateRef), 850);
    },
    async sendMessage(message, channel) {
      const text = String(message?.testo || "").trim();
      if (!text) return;
      try {
        await addDoc(collection(db, "profiles", user.uid, "messages"), {
          senderId: user.uid,
          targetUid: user.uid,
          channel,
          type: String(message.tipo || "message").slice(0, 40),
          text: text.slice(0, 4000),
          metadata: message.meta || null,
          createdAt: serverTimestamp()
        });
      } catch (error) { badgeText(friendlyAuthError(error), true); }
    }
  };

  onSnapshot(stateRef, (snap) => {
    if (!snap.exists()) return;
    const value = snap.data();
    const revision = Number(value.revision || 0);
    if (revision <= knownRevision) return;
    if (saving || pendingSnapshot) {
      badgeText("Conflitto: dati aggiornati su un altro dispositivo", true);
      return;
    }
    knownRevision = revision;
    saveLocal(mergeRemote(value.snapshot, null, profile));
    sessionStorage.setItem(markerKey, `${knownRevision}:${knownProgramVersion}`);
    location.reload();
  }, (error) => badgeText(friendlyAuthError(error), true));

  onSnapshot(programRef, (snap) => {
    const value = snap.exists() ? snap.data() : null;
    const version = value?.versionId || "";
    if (version === knownProgramVersion) return;
    if (pendingSnapshot) return badgeText("Nuova scheda disponibile: salva o ricarica", true);
    knownProgramVersion = version;
    window.__LIPPOLIS_PROGRAM_VERSION__ = version;
    saveLocal(mergeRemote(null, value, profile));
    sessionStorage.setItem(markerKey, `${knownRevision}:${knownProgramVersion}`);
    location.reload();
  }, (error) => badgeText(friendlyAuthError(error), true));

  onSnapshot(query(collection(db, "profiles", user.uid, "messages"), orderBy("createdAt", "asc"), limit(200)), (snap) => {
    const messages = snap.docs.map((item) => {
      const data = item.data();
      return {
        id: item.id,
        ts: data.createdAt?.toMillis?.() || Date.now(),
        from: data.senderId === user.uid ? "atleta" : "coach",
        tipo: data.type || "messaggio",
        testo: data.text,
        meta: data.metadata || null,
        channel: data.channel || "thread",
        letto: true
      };
    });
    api.applyMessages(messages);
  }, (error) => badgeText(friendlyAuthError(error), true));

  cloudReady = true;
  if (pendingSnapshot) flush(user.uid, stateRef);
  else if (!stateSnap.exists()) window.lippolisCloudSync.queue(api.snapshot());
  return true;
}

async function flush(uid, stateRef) {
  if (!cloudReady || saving || !pendingSnapshot) return;
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  saving = true;
  badgeText("Sincronizzazione…");
  try {
    const nextRevision = await runTransaction(db, async (tx) => {
      const current = await tx.get(stateRef);
      const revision = current.exists() ? Number(current.data().revision || 0) : 0;
      if (revision !== knownRevision) throw new Error("CONFLICT");
      tx.set(stateRef, { uid, snapshot, revision: revision + 1, updatedAt: serverTimestamp() });
      return revision + 1;
    });
    knownRevision = nextRevision;
    badgeText("Salvato e sincronizzato");
  } catch (error) {
    pendingSnapshot = snapshot;
    badgeText(error.message === "CONFLICT" ? "Conflitto: ricarica prima di continuare" : "Offline: salvataggio locale in attesa", true);
  } finally { saving = false; }
}

window.addEventListener("online", () => { if (pendingSnapshot && auth.currentUser) flush(auth.currentUser.uid, doc(db, "profiles", auth.currentUser.uid, "state", "app")); });

if (!firebaseConfigured) {
  alert("Configura Firebase in firebase-config.js."); location.replace("index.html");
} else {
  const session = await getAuthorizedSession({ requireRole: "athlete" });
  if (session.reason) { alert(session.reason); location.replace("index.html"); }
  else bootstrap(session).catch((error) => { alert(friendlyAuthError(error)); location.replace("index.html"); });
}
