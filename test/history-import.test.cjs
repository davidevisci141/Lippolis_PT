const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const load = () => import(path.resolve(__dirname, "../supabase/functions/_shared/validation.mjs"));

const session = (extra = {}) => ({ id: "cp-123", ts: Date.UTC(2026, 8, 18, 16), prog: "Marika - 7° livello", settimana: 5, giorno: 3, dt: "D", titolo: "LOWER", nota: "",
  esercizi: [{ nome: "Hip thrust con bilanciere", sets: [{ kg: 17.5, reps: 10, rir: null }, { kg: "20", reps: "9", rir: 2 }], fatto: true, note: "", segnalato: null }], ...extra });

test("validateHistory pulisce sessioni e pesate", async () => {
  const { validateHistory } = await load();
  const out = validateHistory([session({ extra: "via", esercizi: [{ nome: " Curl  singolo ", sets: [{ kg: 5, reps: 10.8 }], uni: true, lati: ["DX", "SX", "boh"], segnalato: { x: 1 } }] })],
    [{ id: "p1", ts: Date.UTC(2026, 9, 1), v: "54,2".replace(",", ".") }]);
  assert.equal(out.sessions[0].extra, undefined);
  assert.equal(out.sessions[0].importata, true);
  assert.deepEqual(out.sessions[0].esercizi[0], { nome: "Curl singolo", sets: [{ kg: 5, reps: 10.8, rir: null }], fatto: true, note: "", segnalato: null, uni: true, lati: ["DX", "SX", "DX"] });
  assert.equal(out.weights[0].v, 54.2);
});

test("validateHistory rifiuta dati non validi", async () => {
  const { validateHistory } = await load();
  assert.throws(() => validateHistory([session({ id: "" })], []), /id non valido/);
  assert.throws(() => validateHistory([session({ ts: Date.now() + 10 * 86400000 })], []), /data non valida/);
  assert.throws(() => validateHistory([session({ esercizi: [{ nome: "", sets: [] }] })], []), /nome mancante/);
  assert.throws(() => validateHistory([], [{ id: "p", ts: Date.UTC(2026, 0, 1), v: 5 }]), /peso non valido/);
  assert.throws(() => validateHistory("x", []), /Sessioni/);
});

test("admin-api espone importAthleteHistory e la migration è riservata al service role", () => {
  const api = fs.readFileSync(path.resolve(__dirname, "../supabase/functions/admin-api/index.ts"), "utf8");
  assert.match(api, /importAthleteHistory, health:/);
  const sql = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/202611150001_coach_import_history.sql"), "utf8");
  assert.match(sql, /coach_owns_athlete\(p_coach, p_athlete\)/);
  assert.match(sql, /grant execute on function public\.coach_import_history\(uuid, uuid, jsonb, jsonb\) to service_role/);
  assert.match(sql, /revoke all on function public\.coach_import_history\(uuid, uuid, jsonb, jsonb\) from public, anon, authenticated/);
});

test("lo storico reale di Marika passa la validazione", async () => {
  const file = "/mnt/user-data/uploads/d1de98d3-lippolis-pt-backup-2026-11-14.json";
  if (!fs.existsSync(file)) return;
  const { validateHistory } = await load();
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = validateHistory(b.sessioni, b.pesi);
  assert.equal(out.sessions.length, 147); assert.equal(out.weights.length, 5);
});
