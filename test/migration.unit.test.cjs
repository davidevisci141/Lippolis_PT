"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("il frontend non carica più SDK Firebase", () => {
  for (const file of ["www/src/auth.mjs", "www/src/login.mjs", "www/src/coach.mjs", "www/src/athlete.mjs"]) {
    const source = read(file);
    assert.doesNotMatch(source, /firebase(js|app|auth|firestore|functions)|gstatic\.com\/firebase/i, file);
  }
});

test("la configurazione pubblica non contiene chiavi amministrative", () => {
  const config = read("www/supabase-config.js");
  assert.match(config, /publishableKey/);
  assert.doesNotMatch(config, /service_role|secretKey|sb_secret_/i);
});

test("lo schema protegge tutte le tabelle applicative con RLS", () => {
  const sql = read("supabase/migrations/202611070001_initial_schema.sql");
  for (const table of ["profiles", "athlete_states", "programs", "program_versions", "messages", "program_drafts", "admin_operations"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"), table);
  }
  assert.match(sql, /STATE_CONFLICT/);
  assert.match(sql, /grant execute on function public\.publish_program[\s\S]+to service_role/i);
});

test("l'API privilegiata verifica l'utente e non espone la secret key", () => {
  const source = read("supabase/functions/admin-api/index.ts");
  assert.match(source, /admin\.auth\.getUser\(token\)/);
  assert.match(source, /SUPABASE_SECRET_KEYS/);
  assert.doesNotMatch(read("www/src/supabase.mjs"), /SUPABASE_SERVICE_ROLE_KEY|service_role/);
});


test("l'archivio originale BIA è privato e vincolato a cliente e trainer", () => {
  const sql = read("supabase/migrations/202611090001_bia_reports.sql");
  assert.match(sql, /'bia-reports'[\s\S]+false[\s\S]+15728640/i);
  assert.match(sql, /private\.can_read_athlete/);
  assert.match(sql, /private\.coach_owns_athlete/);
  assert.match(sql, /\(-preview\)\?/);
  assert.match(sql, /consume_bia_rate_limit/);
});

test("le anteprime BIA vengono archiviate e mostrate insieme agli originali", () => {
  const app = read("www/src/coach.mjs"), html = read("www/coach.html"), api = read("supabase/functions/admin-api/index.ts");
  const migration = read("supabase/migrations/202611100001_bia_report_previews.sql");
  assert.doesNotMatch(html, /id="biaKeepOriginal"/);
  assert.match(app, /upload\(reportPath, pendingBiaFile/);
  assert.match(app, /upload\(reportPreviewPath, previewBlob/);
  assert.match(app, /loadBiaReportPreview\(item\)/);
  assert.match(api, /reportPreviewPath/);
  assert.match(migration, /\(-preview\)\?/);
});

test("BIA salva il valore letto dal referto e valida i controlli sul server", () => {
  const api = read("supabase/functions/admin-api/index.ts");
  assert.match(api, /const bodyFatMassKg = values\.bodyFatMassKg/);
  assert.match(api, /validateBiaMath\(values\)/);
  assert.match(api, /validateArchivedBiaReport\(body\.reportPath, athlete\.id\)/);
  assert.match(api, /sourceAudit/);
  assert.match(api, /consume_bia_rate_limit/);
  assert.doesNotMatch(api, /console\.error\("admin-api", value\?\.message/);
});

test("la BIA richiede la verifica dei valori principali e separa i dettagli", () => {
  const api = read("supabase/functions/admin-api/index.ts"), app = read("www/src/coach.mjs"), html = read("www/coach.html");
  assert.match(api, /const biaRequiredFields = \[\s*"measuredAtLocal", "weightKg", "bodyFatMassKg", "skeletalMuscleKg"/);
  assert.match(app, /source: field\.source === "corretto_manualmente" \? "corretto_manualmente" : "verificato_dal_pt"/);
  assert.match(app, /fatFreeMass\(latest\)/);
  assert.match(html, /id="biaDetailsModal"/);
  assert.match(html, /id="biaLeanPreview"/);
});

test("la revisione BIA blocca il salvataggio e lega i riquadri ai campi OCR", () => {
  const html = read("www/coach.html"), app = read("www/src/coach.mjs");
  assert.match(html, /biaBboxOverlay/);
  assert.match(html, /biaSave[^>]*disabled/);
  assert.match(app, /pendingBia\.fields\?\./);
  assert.match(app, /requiredBiaFields/);
  assert.match(app, /createSignedUrl/);
});

test("la scheda pubblicata è caricata dal database nell'area atleta e le sessioni si sincronizzano", () => {
  const coach = read("www/src/coach.mjs"), athlete = read("www/src/athlete.mjs"), athleteHtml = read("www/athlete.html"), migration = read("supabase/migrations/202611070001_initial_schema.sql");
  assert.match(coach, /calls\.saveProgramDraft/);
  assert.match(coach, /calls\.publishProgram/);
  assert.match(athlete, /from\("programs"\)\.select/);
  assert.match(athlete, /merged\.PROGRAMMA = normalizePublishedProgram\(currentProgram\.program\)/);
  assert.match(athleteHtml, /function rangeSett\(w\)\{ if\(!w\?\.dal/);
  assert.match(athlete, /table: "programs"/);
  assert.match(athlete, /rpc\("save_athlete_state"/);
  assert.match(migration, /create policy programs_select[\s\S]+private\.can_read_athlete/);
  assert.match(migration, /create or replace function public\.publish_program/);
});

test("snapshot, BIA e storico restano persistenti dopo refresh e conflitti offline", () => {
  const athlete = read("www/src/athlete.mjs"), coach = read("www/src/coach.mjs");
  const migration = read("supabase/migrations/202611100002_durable_athlete_state.sql");
  assert.match(athlete, /function mergeQueuedSnapshot\(remote, local\)/);
  assert.match(athlete, /sameSnapshot\(merged, remote\)/);
  assert.match(athlete, /from\("athlete_states"\)\.select\("snapshot, revision"\)/);
  assert.match(athlete, /window\.addEventListener\("pagehide"/);
  assert.match(athlete, /logoutAfterSync/);
  assert.match(coach, /Referto BIA salvato nel database/);
  assert.match(coach, /Scheda pubblicata e verificata/);
  assert.match(migration, /merge_snapshot_array\(v_current -> v_key, v_snapshot -> v_key\)/);
  assert.match(migration, /merge_metric_array\(v_current -> 'metriche', v_snapshot -> 'metriche'\)/);
  assert.match(migration, /coalesce\(v_current -> v_key, '\{\}'::jsonb\) \|\| coalesce\(v_snapshot -> v_key, '\{\}'::jsonb\)/);
});

test("il bundle OCR esporta PaddleOCR e produce il worker separato", () => {
  const config = read("vite.bia.config.mjs"), verifier = read("scripts/verify-bia-runtime.mjs");
  assert.match(config, /preserveEntrySignatures:\s*"strict"/);
  assert.match(config, /entryFileNames:\s*"bia-runtime\.js"/);
  assert.match(verifier, /PaddleOCR/);
  assert.match(verifier, /worker-entry-/);
  assert.match(read("www/src/bia-ocr.mjs"), /Bundle OCR incompleto/);
});

test("le operazioni delle schede sono transazionali, registrate e limitate ai clienti del PT", () => {
  const migration = read("supabase/migrations/202611100003_program_builder_audit.sql");
  assert.match(migration, /create table if not exists public\.program_audit_log/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /save_program_draft[\s\S]+private\.coach_owns_athlete/);
  assert.match(migration, /archive_program_draft[\s\S]+private\.coach_owns_athlete/);
  assert.match(migration, /publish_program[\s\S]+for update/);
  assert.match(migration, /draft_created[\s\S]+draft_updated[\s\S]+draft_archived[\s\S]+published/);
});
