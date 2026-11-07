import { auth, db, assertFirebaseConfigured } from "./firebase.mjs";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

export const ROLE_LABELS = Object.freeze({ coach: "Personal Trainer", athlete: "Cliente" });

export function waitForUser() {
  assertFirebaseConfigured();
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    }, reject);
  });
}

export async function loadProfile(uid) {
  const snap = await getDoc(doc(db, "profiles", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function profileBlockReason(profile) {
  if (!profile) return "Il tuo account non ha un profilo autorizzato.";
  if (!Object.hasOwn(ROLE_LABELS, profile.role)) return "Il ruolo associato all’account non è valido.";
  if (profile.status === "suspended") return "L’accesso è stato sospeso dal Personal Trainer.";
  if (profile.status === "deleting") return "L’eliminazione dell’account è in corso.";
  if (profile.status !== "active") return "L’account non è attivo.";
  return "";
}

export async function getAuthorizedSession({ requireRole, allowOnboarding = false } = {}) {
  const user = await waitForUser();
  if (!user) return { user: null, profile: null, reason: "Devi effettuare l’accesso." };
  const profile = await loadProfile(user.uid);
  const reason = profileBlockReason(profile);
  if (reason) return { user, profile, reason };
  if (requireRole && profile.role !== requireRole) {
    return { user, profile, reason: "Non hai i permessi per aprire quest’area." };
  }
  if (!allowOnboarding && profile.role === "athlete") {
    if (!user.emailVerified) return { user, profile, reason: "Devi verificare l’indirizzo email." };
    if (!profile.onboardingComplete) return { user, profile, reason: "Devi completare il primo accesso." };
  }
  return { user, profile, reason: "" };
}

export function destinationFor(profile) {
  return profile?.role === "coach" ? "coach.html" : "athlete.html";
}

export async function logout() {
  if (auth) await signOut(auth);
  sessionStorage.removeItem("lippolis_uid");
  location.replace("index.html");
}

export function friendlyAuthError(error) {
  const code = String(error?.code || "");
  const messages = {
    "auth/invalid-credential": "Email o password non corretti.",
    "auth/user-disabled": "Questo account è sospeso.",
    "auth/too-many-requests": "Troppi tentativi. Attendi qualche minuto e riprova.",
    "auth/invalid-email": "Inserisci un indirizzo email valido.",
    "auth/weak-password": "La password non rispetta i requisiti di sicurezza.",
    "auth/requires-recent-login": "Per sicurezza devi accedere nuovamente.",
    "functions/already-exists": "Esiste già un account con questa email.",
    "functions/permission-denied": "Non hai i permessi per questa operazione.",
    "functions/failed-precondition": "L’operazione non può essere completata nello stato attuale.",
    "functions/aborted": "I dati sono stati modificati altrove. Ricarica e riprova.",
    "functions/deadline-exceeded": "La richiesta è scaduta. Verifica la connessione e riprova."
  };
  return messages[code] || error?.message || "Operazione non riuscita.";
}
