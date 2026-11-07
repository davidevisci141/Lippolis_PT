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
