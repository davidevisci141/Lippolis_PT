import { assertSupabaseConfigured, normalizeUser, profileFromRow, supabase } from "./supabase.mjs";

export const ROLE_LABELS = Object.freeze({ coach: "Personal Trainer", athlete: "Cliente" });

export async function waitForUser() {
  assertSupabaseConfigured();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return normalizeUser(data.session?.user || null);
}

export async function loadProfile(uid) {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
  if (error) throw error;
  return profileFromRow(data);
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
  if (requireRole && profile.role !== requireRole) return { user, profile, reason: "Non hai i permessi per aprire quest’area." };
  if (!allowOnboarding && profile.role === "athlete" && !profile.onboardingComplete) {
    return { user, profile, reason: "Devi completare il primo accesso." };
  }
  return { user, profile, reason: "" };
}

export function destinationFor(profile) { return profile?.role === "coach" ? "coach.html" : "athlete.html"; }

export async function logout() {
  if (supabase) await supabase.auth.signOut();
  sessionStorage.removeItem("lippolis_uid");
  location.replace("index.html");
}

export function friendlyAuthError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "");
  if (code.includes("invalid_credentials") || /invalid login credentials/i.test(message)) return "Email o password non corretti.";
  if (code.includes("user_banned") || /banned/i.test(message)) return "Questo account è sospeso.";
  if (code.includes("over_request_rate_limit") || /rate limit/i.test(message)) return "Troppi tentativi. Attendi qualche minuto e riprova.";
  if (code.includes("email_exists") || code.includes("already-exists")) return "Esiste già un account con questa email.";
  if (code.includes("permission-denied") || code === "403") return "Non hai i permessi per questa operazione.";
  if (code.includes("conflict") || code.includes("aborted")) return "I dati sono stati modificati altrove. Ricarica e riprova.";
  return message || "Operazione non riuscita.";
}
