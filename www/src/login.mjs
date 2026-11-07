import { auth, functions, firebaseConfigured, missingFirebaseKeys } from "./firebase.mjs";
import { destinationFor, friendlyAuthError, loadProfile, profileBlockReason } from "./auth.mjs";
import {
  getIdToken,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const $ = (id) => document.getElementById(id);
const message = $("message");

function showMessage(text, error = false) {
  message.textContent = text;
  message.className = `message show${error ? " error" : ""}`;
}

function busy(button, state, text) {
  button.disabled = state;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = state ? text : button.dataset.label;
}

document.querySelectorAll("[data-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = $(button.dataset.toggle);
    input.type = input.type === "password" ? "text" : "password";
    button.setAttribute("aria-label", input.type === "password" ? "Mostra password" : "Nascondi password");
  });
});

if (!firebaseConfigured) {
  $("configError").hidden = false;
  $("configError").textContent = `Configurazione Firebase incompleta (${missingFirebaseKeys.join(", ")}). Compila firebase-config.js prima di usare l’accesso.`;
  $("loginForm").querySelectorAll("input,button").forEach((el) => { el.disabled = true; });
}

async function routeUser(user) {
  if (!user) return;
  const profile = await loadProfile(user.uid);
  const reason = profileBlockReason(profile);
  if (reason) {
    await signOut(auth);
    showMessage(reason, true);
    return;
  }

  if (!user.emailVerified || (profile.role === "athlete" && !profile.onboardingComplete)) {
    $("loginBox").classList.add("hidden");
    $("onboardingBox").classList.add("show");
    $("onboardingLead").textContent = `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || user.email;
    $("verifyStep").classList.toggle("done", user.emailVerified);
    $("passwordStep").hidden = !user.emailVerified || profile.role !== "athlete";
    if (user.emailVerified && profile.role === "coach") {
      location.replace(destinationFor(profile));
    }
    return;
  }

  sessionStorage.setItem("lippolis_uid", user.uid);
  location.replace(destinationFor(profile));
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("loginButton");
  busy(button, true, "Accesso…");
  try {
    const credential = await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
    await routeUser(credential.user);
  } catch (error) {
    showMessage(friendlyAuthError(error), true);
  } finally {
    busy(button, false);
  }
});

$("resetButton").addEventListener("click", async () => {
  const email = $("email").value.trim();
  if (!email) return showMessage("Inserisci prima l’indirizzo email.", true);
  try {
    await sendPasswordResetEmail(auth, email);
    showMessage("Se l’account esiste, Firebase ha inviato le istruzioni per reimpostare la password.");
  } catch (error) {
    showMessage(friendlyAuthError(error), true);
  }
});

$("sendVerification").addEventListener("click", async () => {
  try {
    await sendEmailVerification(auth.currentUser, { url: new URL("index.html", location.href).href });
    showMessage("Email di verifica inviata. Apri il link e poi torna qui.");
  } catch (error) {
    showMessage(friendlyAuthError(error), true);
  }
});

$("refreshVerification").addEventListener("click", async () => {
  try {
    await reload(auth.currentUser);
    await routeUser(auth.currentUser);
    if (!auth.currentUser.emailVerified) showMessage("L’email non risulta ancora verificata.", true);
  } catch (error) {
    showMessage(friendlyAuthError(error), true);
  }
});

$("completeOnboarding").addEventListener("click", async () => {
  const button = $("completeOnboarding");
  const password = $("newPassword").value;
  if (password.length < 12) return showMessage("La password deve contenere almeno 12 caratteri.", true);
  if (password !== $("confirmPassword").value) return showMessage("Le password non coincidono.", true);
  busy(button, true, "Completamento…");
  try {
    await updatePassword(auth.currentUser, password);
    await getIdToken(auth.currentUser, true);
    await httpsCallable(functions, "completeOnboarding")({});
    const profile = await loadProfile(auth.currentUser.uid);
    sessionStorage.setItem("lippolis_uid", auth.currentUser.uid);
    location.replace(destinationFor(profile));
  } catch (error) {
    showMessage(friendlyAuthError(error), true);
  } finally {
    busy(button, false);
  }
});

$("onboardingLogout").addEventListener("click", async () => {
  await signOut(auth);
  location.reload();
});

if (firebaseConfigured) {
  let firstAuthState = true;
  onAuthStateChanged(auth, (user) => {
    if (!firstAuthState) return;
    firstAuthState = false;
    if (user) routeUser(user).catch((error) => showMessage(friendlyAuthError(error), true));
  });
}
