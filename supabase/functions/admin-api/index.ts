import { createClient as createSupabaseClient } from "npm:@supabase/supabase-js@2";
import { cleanText, validateHistory, validateId, validateProgram } from "../_shared/validation.mjs";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
class ApiError extends Error { code: string; status: number; constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; } }
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (error: unknown) => {
  const known = error instanceof ApiError; const value = error as Error & { code?: string };
  console.error("admin-api", { code: known ? value.code : value?.code || "internal", status: known ? value.status : 500 });
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

function optionalNumber(value: unknown, label: string, min: number, max: number) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new ApiError("invalid-argument", `${label}: valore non valido.`);
  return Math.round(number * 100) / 100;
}

const biaRequiredFields = [
  "measuredAtLocal", "weightKg", "bodyFatMassKg", "skeletalMuscleKg"
];
const biaReportTypes: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", pdf: "application/pdf" };
function validatedSourceAudit(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("invalid-argument", "Conferma i valori principali del referto prima di salvare.");
  const audit = value as Record<string, unknown>, sourceFields = audit.fields;
  if (!sourceFields || typeof sourceFields !== "object" || Array.isArray(sourceFields)) throw new ApiError("invalid-argument", "Provenienza dei campi non valida.");
  const fields = sourceFields as Record<string, unknown>, normalized: Record<string, unknown> = {};
  for (const key of biaRequiredFields) {
    const entry = fields[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ApiError("invalid-argument", "Alcuni valori principali non sono stati verificati.");
    const item = entry as Record<string, unknown>, source = String(item.source || ""), confidence = Number(item.confidence);
    if (item.status !== "ok" || !["ocr", "pdf", "corretto_manualmente", "verificato_dal_pt"].includes(source) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || (source === "ocr" && confidence < 0.82)) {
      throw new ApiError("invalid-argument", "Verifica i valori principali guardando il referto.");
    }
    let bbox: number[][] | null = null;
    if (item.bbox !== null && item.bbox !== undefined) {
      if (!Array.isArray(item.bbox) || item.bbox.length < 3 || item.bbox.length > 8 || item.bbox.some((point) => !Array.isArray(point) || point.length !== 2 || point.some((coordinate) => !Number.isFinite(Number(coordinate)) || Number(coordinate) < 0 || Number(coordinate) > 1))) {
        throw new ApiError("invalid-argument", "Coordinate OCR non valide.");
      }
      bbox = item.bbox.map((point) => (point as unknown[]).map(Number));
    }
    normalized[key] = { status: "ok", source, confidence, bbox };
  }
  const confirmation = audit.confirmation as Record<string, unknown> | null;
  if (!confirmation || confirmation.manuallyConfirmed !== true) throw new ApiError("invalid-argument", "Conferma di aver controllato i valori principali sul referto.");
  return { fields: normalized, confirmation: { manuallyConfirmed: true } };
}
async function validateArchivedBiaReport(path: unknown, athleteId: string) {
  if (path === null || path === undefined || path === "") return null;
  const safePath = String(path), uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const match = safePath.match(new RegExp(`^(${uuid})/(${uuid})(?:-preview)?\\.(jpg|png|webp|heic|pdf)$`, "i"));
  if (!match || match[1].toLowerCase() !== athleteId.toLowerCase()) throw new ApiError("invalid-argument", "Percorso del referto non valido.");
  const { data: file, error } = await admin.storage.from("bia-reports").download(safePath);
  if (error || !file || file.size <= 0 || file.size > 15 * 1024 * 1024) throw new ApiError("invalid-argument", "Il referto archiviato non è leggibile o supera 15 MB.");
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (from: number, length: number) => String.fromCharCode(...bytes.slice(from, from + length));
  let actual = "";
  if (starts(0xff, 0xd8, 0xff)) actual = "image/jpeg";
  else if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) actual = "image/png";
  else if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") actual = "image/webp";
  else if (ascii(0, 5) === "%PDF-") actual = "application/pdf";
  else if (ascii(4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/i.test(ascii(8, 4))) actual = "image/heic";
  if (actual !== biaReportTypes[match[3].toLowerCase()] || (file.type && file.type !== actual)) throw new ApiError("invalid-argument", "Il contenuto del referto non corrisponde al formato consentito.");
  return safePath;
}
function validateBiaMath(values: Record<string, number | null>) {
  const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
  const has = (...keys: string[]) => keys.every((key) => values[key] !== null);
  const v = (key: string) => values[key] as number;
  if (has("totalBodyWaterL", "proteinKg", "mineralsKg") && !near(v("weightKg"), v("totalBodyWaterL") + v("proteinKg") + v("mineralsKg") + v("bodyFatMassKg"), 0.3)) throw new ApiError("invalid-argument", "Il peso non coincide con la somma dei componenti corporei.");
  if (has("bmi", "heightCm") && !near(v("bmi"), v("weightKg") / ((v("heightCm") / 100) ** 2), 0.15)) throw new ApiError("invalid-argument", "IMC non coerente con peso e altezza.");
  if (has("bodyFatPercent") && !near(v("bodyFatPercent"), v("bodyFatMassKg") / v("weightKg") * 100, 0.3)) throw new ApiError("invalid-argument", "Percentuale di grasso non coerente con peso e massa grassa.");
  if (has("targetWeightKg", "weightControlKg") && !near(v("targetWeightKg"), v("weightKg") + v("weightControlKg"), 0.2)) throw new ApiError("invalid-argument", "Peso obiettivo non coerente con il controllo del peso.");
  if (has("weightControlKg", "fatControlKg", "muscleControlKg") && !near(v("weightControlKg"), v("fatControlKg") + v("muscleControlKg"), 0.2)) throw new ApiError("invalid-argument", "Controllo peso non coerente con grasso e muscolo.");
  if (has("heightCm", "obesityDegreePercent")) {
    const obesity = v("weightKg") / (22 * ((v("heightCm") / 100) ** 2)) * 100;
    if (!near(v("obesityDegreePercent"), obesity, 1.1)) throw new ApiError("invalid-argument", "Grado di obesità non coerente con peso e altezza.");
  }
  const leanMass = v("weightKg") - v("bodyFatMassKg");
  if (leanMass <= 0 || v("skeletalMuscleKg") > leanMass + 0.2) throw new ApiError("invalid-argument", "Massa muscolare incompatibile con la massa magra. Controlla i valori sul referto.");
}
async function recordBia(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  return writeBia(authorizationHeader,body,false);
}
async function updateBia(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  return writeBia(authorizationHeader,body,true);
}
async function writeBia(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>, editing: boolean) {
  const coach = await requireCoach(authorizationHeader); const athlete = await ownedAthlete(coach.user.id, body.clientUid);
  const { data: rateAllowed, error: rateError } = await admin.rpc("consume_bia_rate_limit", { p_actor: coach.user.id });
  if (rateError) throw rateError;
  if (rateAllowed !== true) throw new ApiError("rate-limited", "Hai raggiunto il limite temporaneo di salvataggi BIA. Riprova tra qualche minuto.", 429);
  const sourceAudit = editing ? null : validatedSourceAudit(body.sourceAudit);
  const { data: current, error: readError } = await admin.from("athlete_states").select("snapshot, revision").eq("user_id", athlete.id).maybeSingle();
  if (readError) throw readError;
  const snapshot = current?.snapshot && typeof current.snapshot === "object" ? current.snapshot as Record<string, unknown> : {};
  const bia = Array.isArray(snapshot.bia) ? snapshot.bia as Record<string, unknown>[] : [];
  const previous = editing ? bia.find(item => item.id === body.biaId) : undefined;
  if (editing && !previous) throw new ApiError("not-found", "Referto non trovato.", 404);
  if (previous && Number(body.expectedRevision) !== Number(current?.revision)) {
    throw new ApiError("aborted", "Lo storico è stato aggiornato. Riapri il referto e riprova.", 409);
  }
  const parsedDate = new Date(String(body.measuredAt || ""));
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.getTime() > Date.now() + 5 * 60 * 1000) throw new ApiError("invalid-argument", "Data e ora del referto non valide.");
  const ranges: Record<string, [number, number, string]> = {
    age: [5, 100, "Età"], heightCm: [120, 230, "Altezza"], weightKg: [30, 250, "Peso"],
    bodyFatPercent: [2, 60, "Grasso corporeo"], bodyFatMassKg: [0.1, 100, "Massa grassa"], skeletalMuscleKg: [1, 150, "Massa muscolare"],
    totalBodyWaterL: [1, 200, "Acqua corporea"], proteinKg: [0.1, 100, "Proteine"], mineralsKg: [0.1, 50, "Minerali"],
    bmi: [10, 60, "IMC"], obesityDegreePercent: [30, 300, "Grado di obesità"], visceralFatLevel: [1, 20, "Grasso viscerale"],
    basalMetabolicRateKcal: [500, 6000, "Metabolismo basale"], waistHipRatio: [0.3, 2, "Rapporto vita/fianchi"], score: [0, 100, "Punteggio"],
    targetWeightKg: [20, 250, "Peso obiettivo"], weightControlKg: [-200, 200, "Controllo peso"], fatControlKg: [-200, 200, "Controllo grasso"], muscleControlKg: [-200, 200, "Controllo muscolo"]
  };
  const values: Record<string, number | null> = {};
  for (const [key, [min, max, label]] of Object.entries(ranges)) {
    const value = optionalNumber(Object.hasOwn(body,key) ? body[key] : previous?.[key], label, min, max);
    values[key] = value;
  }
  for (const key of ["weightKg", "bodyFatMassKg", "skeletalMuscleKg"]) if (values[key] === null) throw new ApiError("invalid-argument", `${key}: campo obbligatorio.`);
  const sex = Object.hasOwn(body,"sex") ? body.sex : previous?.sex;
  if (sex != null && sex !== "male" && sex !== "female") throw new ApiError("invalid-argument", "Sesso non valido.");
  validateBiaMath(values);
  const reportPath = previous ? previous.reportPath : await validateArchivedBiaReport(body.reportPath, athlete.id);
  const reportPreviewPath = previous ? previous.reportPreviewPath : await validateArchivedBiaReport(body.reportPreviewPath, athlete.id);
  if (!editing) {
    if (typeof reportPath !== "string" || !reportPreviewPath) throw new ApiError("invalid-argument", "L’originale e la sua anteprima devono essere archiviati prima del salvataggio.");
    if (reportPreviewPath !== reportPath.replace(/\.[^.]+$/, "-preview.jpg")) throw new ApiError("invalid-argument", "Il referto e la sua anteprima non corrispondono.");
  }
  const reportId = previous ? previous.reportId : body.reportId == null ? null : cleanText(body.reportId, 40);
  if (bia.some(item => item !== previous && Math.floor(new Date(String(item.measuredAt || "")).getTime() / 60000) === Math.floor(parsedDate.getTime() / 60000))) throw new ApiError("already-exists", "Esiste già una rilevazione BIA per questa data e ora.", 409);
  const measuredAt = parsedDate.toISOString();
  const bodyFatMassKg = values.bodyFatMassKg as number;
  const weightKg = values.weightKg as number;
  const record = {
    ...previous,
    id: previous?.id ?? crypto.randomUUID(), measuredAt, age: values.age, sex: sex ?? null, heightCm: values.heightCm,
    weightKg, bmi: values.bmi, obesityDegreePercent: values.obesityDegreePercent,
    bodyFatPercent: values.bodyFatPercent, bodyFatMassKg, fatFreeMassKg: Math.round((weightKg - bodyFatMassKg) * 100) / 100,
    skeletalMuscleKg: values.skeletalMuscleKg, totalBodyWaterL: values.totalBodyWaterL, proteinKg: values.proteinKg,
    mineralsKg: values.mineralsKg, visceralFatLevel: values.visceralFatLevel, basalMetabolicRateKcal: values.basalMetabolicRateKcal,
    waistHipRatio: values.waistHipRatio, score: values.score, targetWeightKg: values.targetWeightKg,
    weightControlKg: values.weightControlKg, fatControlKg: values.fatControlKg, muscleControlKg: values.muscleControlKg,
    reportId, device: previous?.device ?? "InBody120", reportPath, reportPreviewPath,
    sourceAudit: previous?.sourceAudit ?? sourceAudit,
    ...(previous ? { manuallyEditedAt: new Date().toISOString() } : {})
  };
  if (!current) {
    const { error } = await admin.from("athlete_states").insert({ user_id: athlete.id, snapshot: { ...snapshot, bia: [record] }, revision: 1 });
    if (error) { if (error.code === "23505") throw new ApiError("aborted", "Lo storico è stato aggiornato. Riprova.", 409); throw error; }
  } else {
    const revision = Number(current.revision || 0);
    const records = previous ? bia.map(item => item === previous ? record : item) : [...bia, record];
    const { data, error } = await admin.from("athlete_states").update({ snapshot: { ...snapshot, bia: records }, revision: revision + 1, updated_at: new Date().toISOString() }).eq("user_id", athlete.id).eq("revision", revision).select("revision").maybeSingle();
    if (error) throw error; if (!data) throw new ApiError("aborted", "I dati dell’atleta sono cambiati. Ricarica e riprova.", 409);
  }
  return { record };
}
async function deleteBia(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader);
  const athlete = await ownedAthlete(coach.user.id, body.clientUid);
  const id = validateId(body.biaId, "ID referto");
  const { data: paths, error } = await admin.rpc("remove_bia_record", { p_coach: coach.user.id, p_athlete: athlete.id, p_record: id });
  if (error) throw error;
  if (paths?.length) {
    const { error: storageError } = await admin.storage.from("bia-reports").remove(paths);
    if (storageError) throw new ApiError("storage-cleanup-failed", "Referto rimosso dallo storico. Riprova per completare la rimozione del file.", 503);
  }
  return { deleted: true };
}
async function deleteClient(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const target = await ownedAthlete(coach.user.id, body.clientUid);
  if (cleanText(body.confirmationEmail, 254).toLowerCase() !== String(target.email).toLowerCase()) throw new ApiError("invalid-argument", "Email di conferma non corrispondente.");
  const { data: athleteState, error: stateError } = await admin.from("athlete_states").select("snapshot").eq("user_id", target.id).maybeSingle();
  if (stateError) throw stateError;
  const bia = Array.isArray((athleteState?.snapshot as Record<string, unknown> | null)?.bia) ? (athleteState?.snapshot as Record<string, unknown>).bia as Record<string, unknown>[] : [];
  const reportPaths = [...new Set(bia.flatMap((record) => [record.reportPath, record.reportPreviewPath]).filter((value): value is string => typeof value === "string" && new RegExp(`^${target.id}/[0-9a-f-]{8}-[0-9a-f-]{4}-[1-8][0-9a-f-]{3}-[89ab][0-9a-f-]{3}-[0-9a-f-]{12}(?:-preview)?[.](jpg|png|webp|heic|pdf)$`, "i").test(value)))];
  if (reportPaths.length) {
    const { error: storageError } = await admin.storage.from("bia-reports").remove(reportPaths);
    if (storageError) throw new ApiError("storage-cleanup-failed", "Non è stato possibile rimuovere gli originali BIA. Account non eliminato.", 500);
  }
  const clientFiles = admin.storage.from("coach-client-files");
  for (let page = 0; page < 100; page++) {
    const { data: files, error: listError } = await clientFiles.list(target.id, { limit: 100 });
    if (listError) throw new ApiError("storage-cleanup-failed", "Non è stato possibile leggere gli allegati del cliente. Account non eliminato.", 500);
    if (!files?.length) break;
    const { error: removalError } = await clientFiles.remove(files.map((file) => `${target.id}/${file.name}`));
    if (removalError) throw new ApiError("storage-cleanup-failed", "Non è stato possibile rimuovere gli allegati del cliente. Account non eliminato.", 500);
    if (page === 99) throw new ApiError("storage-cleanup-failed", "Restano allegati da rimuovere. Ripeti l’eliminazione.", 500);
  }
  await admin.from("profiles").update({ status: "deleting", updated_at: new Date().toISOString() }).eq("id", target.id);
  const { error } = await admin.auth.admin.deleteUser(target.id); if (error) throw error;
  return { deleted: true, uid: target.id };
}

async function saveProgramDraft(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const athlete = await ownedAthlete(coach.user.id, body.clientUid); const program = validateProgram(body.program);
  const expected = Number(body.expectedRevision || 0);
  if (!Number.isSafeInteger(expected) || expected < 0) throw new ApiError("invalid-argument", "Revisione bozza non valida.");
  const draftId = body.draftId ? validateId(body.draftId, "ID bozza") : null;
  const { data, error } = await admin.rpc("save_program_draft", {
    p_coach_id: coach.user.id, p_athlete_id: athlete.id, p_draft_id: draftId,
    p_expected_revision: expected, p_program: program
  });
  if (error) {
    if (error.code === "PT409" || error.code === "40001") throw new ApiError("aborted", "La bozza è stata modificata altrove. Ricaricala prima di salvare.", 409);
    if (error.code === "P0001") throw new ApiError("not-found", "Bozza non trovata o già archiviata.", 404);
    throw error;
  }
  return data;
}

async function publishProgram(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const athlete = await ownedAthlete(coach.user.id, body.clientUid); const draftId = validateId(body.draftId, "ID bozza");
  const expectedRevision = Number(body.expectedRevision || 0);
  const { data: draft, error: draftError } = await admin.from("program_drafts").select("program, revision, status, published_version_id").eq("id", draftId).eq("coach_id", coach.user.id).eq("athlete_id", athlete.id).maybeSingle();
  if (draftError) throw draftError;
  if (!draft) throw new ApiError("not-found", "Bozza non trovata.", 404);
  if (Number(draft.revision) !== expectedRevision) throw new ApiError("aborted", "La bozza è stata modificata altrove.", 409);
  if (draft.status === "published" && draft.published_version_id) {
    const { data: active, error: activeError } = await admin.from("programs").select("version_id, revision").eq("athlete_id", athlete.id).maybeSingle();
    if (activeError) throw activeError;
    if (active?.version_id === draft.published_version_id) return { versionId: active.version_id, revision: active.revision };
    throw new ApiError("aborted", "Questa versione è già stata sostituita da una pubblicazione successiva.", 409);
  }
  if (draft.status !== "draft") throw new ApiError("not-found", "Bozza non trovata o già archiviata.", 404);
  const canonicalProgram = validateProgram(draft.program, { forPublish: true });
  if (Number((draft.program as Record<string, unknown>)?.schemaVersion || (draft.program as Record<string, unknown>)?.schema_version) === 2) {
    const { data: refreshed, error: refreshError } = await admin.from("program_drafts").update({ program: canonicalProgram })
      .eq("id", draftId).eq("coach_id", coach.user.id).eq("athlete_id", athlete.id).eq("status", "draft")
      .eq("revision", expectedRevision).select("id").maybeSingle();
    if (refreshError) throw refreshError;
    if (!refreshed) throw new ApiError("aborted", "La bozza è stata modificata altrove. Ricaricala prima di pubblicare.", 409);
  }
  const { data, error } = await admin.rpc("publish_program", { p_coach_id: coach.user.id, p_athlete_id: athlete.id, p_draft_id: draftId, p_expected_revision: Number(body.expectedRevision || 0) });
  if (error) { if (error.code === "PT409" || error.code === "40001") throw new ApiError("aborted", "La bozza è stata modificata altrove.", 409); throw error; }
  return data;
}

async function archiveProgramDraft(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const id = validateId(body.draftId, "ID bozza");
  const { data, error } = await admin.rpc("archive_program_draft", { p_coach_id: coach.user.id, p_draft_id: id });
  if (error) { if (error.code === "P0001") throw new ApiError("not-found", "Bozza non trovata o non archiviabile.", 404); throw error; }
  return data;
}

async function importAthleteHistory(authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) {
  const coach = await requireCoach(authorizationHeader); const athlete = await ownedAthlete(coach.user.id, body.clientUid);
  let history;
  try { history = validateHistory(body.sessioni, body.pesi); } catch (error) { throw new ApiError("invalid-argument", error instanceof Error ? error.message : "Storico non valido.", 400); }
  const { data, error } = await admin.rpc("coach_import_history", { p_coach: coach.user.id, p_athlete: athlete.id, p_sessioni: history.sessions, p_pesi: history.weights });
  if (error) throw error;
  return data;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return fail(new ApiError("method-not-allowed", "Metodo non consentito.", 405));
  try {
    const authorizationHeader = request.headers?.get?.("Authorization") || null;
    const body = await request.json(); const action = String(body.action || "");
    const handlers: Record<string, (authorizationHeader: AuthorizationHeader, body: Record<string, unknown>) => Promise<unknown>> = {
      completeOnboarding: (authorization) => completeOnboarding(authorization), setClientAccess, exportClientData, recordBia, updateBia, deleteBia, deleteClient,
      saveProgramDraft, publishProgram, archiveProgramDraft, importAthleteHistory, health: async () => ({ ok: true, time: new Date().toISOString() })
    };
    if (!handlers[action]) throw new ApiError("invalid-argument", "Azione non valida.");
    return ok(await handlers[action](authorizationHeader, body));
  } catch (error) { return fail(error); }
});
