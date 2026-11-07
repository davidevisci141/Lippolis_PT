import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  connectFirestoreEmulator,
  getFirestore
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  connectFunctionsEmulator,
  getFunctions
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const config = window.LIPPOLIS_FIREBASE_CONFIG || {};
const missing = ["apiKey", "authDomain", "projectId", "appId"].filter(
  (key) => !config[key] || /^(LA_TUA_|IL_TUO_)/.test(String(config[key]))
);

export const firebaseConfigured = missing.length === 0;
export const missingFirebaseKeys = missing;

const app = firebaseConfigured
  ? (getApps()[0] || initializeApp(config))
  : null;

export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export const functions = app ? getFunctions(app, "europe-west1") : null;

if (auth) {
  await setPersistence(auth, browserLocalPersistence);
}

const emulatorRequested = app && (
  new URLSearchParams(location.search).get("emulator") === "1" ||
  localStorage.getItem("lippolis_use_emulators") === "1"
);

if (emulatorRequested && !window.__LIPPOLIS_EMULATORS_CONNECTED__) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  window.__LIPPOLIS_EMULATORS_CONNECTED__ = true;
}

export function assertFirebaseConfigured() {
  if (!firebaseConfigured) {
    throw new Error(`Configurazione Firebase incompleta: ${missing.join(", ")}`);
  }
}
