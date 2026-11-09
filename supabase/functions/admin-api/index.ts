import { createClient as createSupabaseClient } from "npm:@supabase/supabase-js@2";
import { cleanText, validateCreateClient, validateId, validateProgram } from "../_shared/validation.mjs";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
class ApiError extends Error { code: string; status: number; constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; } }
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (error: unknown) => {
  const known = error instanceof ApiError; const value = error as Error & { code?: string };
  console.error("admin-api", value?.message || error);
  return new Response(JSON.stringify({ code: known ? value.code : value?.code || "internal", error: known ? value.message : "Operazione non riuscita." }), {
    status: known ? (error as ApiError).status : 500, headers: { ...cors, "Content-Type": "application/json" }
  });
};

const url = Deno.env.get("SUPABASE_URL")!;
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const secretKey = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !secretKey) throw new Error("Supabase Secret key non disponibile nel runtime.");
const admin = createSupabaseClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

type AuthorizationHeader = string | null;

async function actorFromAuthorization(authorizationHeader: AuthorizationHeader) {
  const token = authorizationHeader?.replace(/^Bearer\s+/i, "");
  if (!token) throw new ApiError("unauthenticated", "Accesso richiesto.", 401);
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new ApiError("unauthenticated", "Sessione non valida.", 401);
  const { data: profile, error: profileError } = await admin.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (profileError || !profile || profile.status !== "active") throw new ApiError("permission-denied", "Account non autorizzato.", 403);
  return { user, profile };
}
async function requireCoach(authorizationHeader: AuthorizationHeader) {
  const actor = await actorFromAuthorization(authorizationHeader);
  if (actor.profile.role !== "coach") throw new ApiError("permission-denied", "Operazione riservata al Personal Trainer.", 403);
  return actor;
}
async function ownedAthlete(coachId: string, athleteId: unknown) {
  const id = validateId(athleteId, "UID cliente");
  const { data, error } = await admin.from("profiles").select("*").eq("id", id).eq("role", "athlete").eq("trainer_id", coachId).maybeSingle();
  if (error || !data) throw new ApiError("permission-denied", "Cliente non assegnato a questo PT.", 403);
  return data;
}

async function createAthleteAccount(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const input = validateCreateClient(body);
  const { data: previous } = await admin.from("admin_operations").select("*").eq("actor_id", coach.user.id).eq("operation_type", "createClient").eq("idempotency_key", input.idempotencyKey).maybeSingle();
  if (previous?.status === "completed") return previous.result;
  if (previous && previous.request?.email !== input.email) throw new ApiError("already-exists", "Identificativo richiesta già utilizzato.", 409);
  if (!previous) {
    const { error } = await admin.from("admin_operations").insert({ actor_id: coach.user.id, operation_type: "createClient", idempotency_key: input.idempotencyKey, status: "reserved", request: { email: input.email } });
    if (error?.code === "23505") return createAthleteAccount(authorizationHeader, body);
    if (error) throw error;
  }
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: input.email, password: input.password, email_confirm: true,
    user_metadata: { first_name: input.firstName, last_name: input.lastName, role: "athlete" }
  });
  if (createError || !created.user) {
    if (/already|registered|exists/i.test(createError?.message || "")) throw new ApiError("already-exists", "Esiste già un account con questa email.", 409);
    throw createError || new Error("Creazione account non riuscita.");
  }
  const profile = { id: created.user.id, first_name: input.firstName, last_name: input.lastName, display_name: `${input.firstName} ${input.lastName}`, email: input.email, role: "athlete", trainer_id: coach.user.id, status: "active", onboarding_complete: false };
  const { error: profileError } = await admin.from("profiles").insert(profile);
  if (profileError) { await admin.auth.admin.deleteUser(created.user.id); throw profileError; }
  const result = { uid: created.user.id, email: input.email, firstName: input.firstName, lastName: input.lastName };
  await admin.from("admin_operations").update({ status: "completed", target_user_id: created.user.id, result, updated_at: new Date().toISOString() }).eq("actor_id", coach.user.id).eq("operation_type", "createClient").eq("idempotency_key", input.idempotencyKey);
  return result;
}

async function completeOnboarding(authorizationHeader: AuthorizationHeader) {
  const actor = await actorFromAuthorization(authorizationHeader);
  if (actor.profile.role !== "athlete") throw new ApiError("permission-denied", "Profilo cliente non autorizzato.", 403);
  const { error } = await admin.from("profiles").update({ onboarding_complete: true, onboarding_completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", actor.user.id);
  if (error) throw error; return { completed: true };
}

async function setClientAccess(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const target = await ownedAthlete(coach.user.id, body.clientUid);
  const action = String(body.action || ""); if (!['suspend', 'reactivate'].includes(action)) throw new ApiError("invalid-argument", "Azione non valida.");
  const suspended = action === "suspend";
  const { error: authError } = await admin.auth.admin.updateUserById(target.id, { ban_duration: suspended ? "876000h" : "none" });
  if (authError) throw authError;
  const values = suspended
    ? { status: "suspended", suspended_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    : { status: "active", suspended_at: null, reactivated_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const { error } = await admin.from("profiles").update(values).eq("id", target.id); if (error) throw error;
  return { uid: target.id, status: values.status };
}

async function exportClientData(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const profile = await ownedAthlete(coach.user.id, body.clientUid); const id = profile.id;
  const [program, state, messages, versions] = await Promise.all([
    admin.from("programs").select("*").eq("athlete_id", id), admin.from("athlete_states").select("*").eq("user_id", id),
    admin.from("messages").select("*").eq("athlete_id", id).order("created_at"), admin.from("program_versions").select("*").eq("athlete_id", id).order("archived_at", { ascending: false })
  ]);
  for (const query of [program, state, messages, versions]) if (query.error) throw query.error;
  return { exportedAt: new Date().toISOString(), profile, program: program.data, state: state.data, messages: messages.data, programVersions: versions.data };
}

async function deleteClient(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const target = await ownedAthlete(coach.user.id, body.clientUid);
  if (cleanText(body.confirmationEmail, 254).toLowerCase() !== String(target.email).toLowerCase()) throw new ApiError("invalid-argument", "Email di conferma non corrispondente.");
  await admin.from("profiles").update({ status: "deleting", updated_at: new Date().toISOString() }).eq("id", target.id);
  const { error } = await admin.auth.admin.deleteUser(target.id); if (error) throw error;
  return { deleted: true, uid: target.id };
}

async function saveProgramDraft(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const athlete = await ownedAthlete(coach.user.id, body.clientUid); const program = validateProgram(body.program);
  const expected = Number(body.expectedRevision || 0); const now = new Date().toISOString();
  if (body.draftId) {
    const id = validateId(body.draftId, "ID bozza");
    const { data, error } = await admin.from("program_drafts").update({ program, revision: expected + 1, updated_at: now }).eq("id", id).eq("coach_id", coach.user.id).eq("athlete_id", athlete.id).eq("status", "draft").eq("revision", expected).select("id, revision").maybeSingle();
    if (error) throw error; if (!data) throw new ApiError("aborted", "La bozza è stata modificata altrove.", 409);
    return { draftId: data.id, revision: data.revision };
  }
  const { data, error } = await admin.from("program_drafts").insert({ coach_id: coach.user.id, athlete_id: athlete.id, program, revision: 1 }).select("id, revision").single();
  if (error) throw error; return { draftId: data.id, revision: data.revision };
}

async function publishProgram(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const athlete = await ownedAthlete(coach.user.id, body.clientUid); const draftId = validateId(body.draftId, "ID bozza");
  const { data, error } = await admin.rpc("publish_program", { p_coach_id: coach.user.id, p_athlete_id: athlete.id, p_draft_id: draftId, p_expected_revision: Number(body.expectedRevision || 0) });
  if (error) { if (error.code === "40001") throw new ApiError("aborted", "La bozza è stata modificata altrove.", 409); throw error; }
  return data;
}

async function archiveProgramDraft(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const id = validateId(body.draftId, "ID bozza");
  const { data, error } = await admin.from("program_drafts").update({ status: "archived", archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).eq("coach_id", coach.user.id).select("id").maybeSingle();
  if (error) throw error; if (!data) throw new ApiError("not-found", "Bozza non trovata.", 404); return { archived: true };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return fail(new ApiError("method-not-allowed", "Metodo non consentito.", 405));
  try {
    const authorizationHeader = request.headers?.get?.("Authorization") || null;
    const body = await request.json(); const action = String(body.action || "");
    const handlers: Record<string, (authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) => Promise<unknown>> = {
      createClient: createAthleteAccount, completeOnboarding: (authorization) => completeOnboarding(authorization), setClientAccess, exportClientData, deleteClient,
      saveProgramDraft, publishProgram, archiveProgramDraft, health: async () => ({ ok: true, time: new Date().toISOString() })
    };
    if (!handlers[action]) throw new ApiError("invalid-argument", "Azione non valida.");
    return ok(await handlers[action](authorizationHeader, body));
  } catch (error) { return fail(error); }
});
