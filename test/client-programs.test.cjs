const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const load = () => import(path.resolve(__dirname, "../www/src/coach-mockup-model.mjs"));
const ts = (d) => Date.parse(d + "T18:00:00Z");
const ses = (d, prog, title = "A") => ({ id: d + prog, ts: ts(d), prog, titolo: title, esercizi: [{ nome: "Leg press", sets: [{ kg: 40, reps: 10 }] }] });
const week = (n, dal, al) => ({ n, dal, al, giorni: [{}, {}, {}, {}] });

test("clientProgramList divide in corso e concluse e unisce lo storico", async () => {
  const { clientProgramList } = await load();
  const active = { version_id: "v2", program: { nome: "M - 9° livello", dal: "2026-11-16", al: "2026-12-27", settimane: [week(1, "2026-11-16", "2026-11-22"), week(2, "2026-11-23", "2026-11-29")] } };
  const versions = [{ id: "v1", program: { nome: "M - 8° livello", dal: "2026-09-28", al: "2026-11-15", settimane: [week(1, "2026-09-28", "2026-10-04")] } }];
  const snapshot = { sessioni: [ses("2025-09-15", "M - 1° livello"), ses("2025-10-20", "M - 1° livello"), ses("2026-10-01", "M - 8° livello"),
    ses("2026-11-17", "M - 9° livello"), ses("2026-11-18", "", "senza programma")] };
  const { inCorso, concluse } = clientProgramList({ snapshot, active, versions, today: "2026-11-25" });
  assert.deepEqual(inCorso.map(r => [r.name, r.done, r.expected, r.skipped]), [["M - 9° livello", 1, 8, 3]]);
  assert.deepEqual(concluse.map(r => [r.name, r.published, r.start, r.end, r.done, r.skipped]),
    [["M - 8° livello", true, "2026-09-28", "2026-11-15", 1, 3], ["M - 1° livello", false, "2025-09-15", "2025-10-20", 2, null]]);
});

test("una scheda attiva già finita va tra le concluse", async () => {
  const { clientProgramList } = await load();
  const active = { version_id: "v1", program: { nome: "X", dal: "2026-01-05", al: "2026-02-15", settimane: [] } };
  const out = clientProgramList({ snapshot: {}, active, versions: [], today: "2026-03-01" });
  assert.equal(out.inCorso.length, 0); assert.equal(out.concluse[0].name, "X");
});

test("athleteSessions elenca le sedute con le serie, dalla più recente", async () => {
  const { athleteSessions } = await load();
  const out = athleteSessions({ sessioni: [ses("2026-10-01", "P"), { id: "v", ts: ts("2026-10-02"), esercizi: [{ nome: "Vuoto", sets: [] }] },
    { id: "u", ts: ts("2026-10-03"), titolo: "B", esercizi: [{ nome: "Curl singolo", sets: [{ kg: "5", reps: 10 }, { kg: 5, reps: 9 }], lati: ["DX", "SX"] }] }] });
  assert.deepEqual(out.map(s => s.id), ["u", "2026-10-01P"]);
  assert.deepEqual(out[0].exercises[0].sets.map(x => x.series), ["1 DX", "1 SX"]);
});

test("le sedute con lo stesso nome fuori dalle date della scheda restano nello storico", async () => {
  const { clientProgramList } = await load();
  const active = { version_id: "v9", program: { nome: "M - 8° livello", dal: "2026-11-16", al: "2027-01-03", settimane: [] } };
  const snapshot = { sessioni: [ses("2026-10-01", "M - 8° livello"), ses("2026-10-08", "M - 8° livello"), ses("2026-11-17", "M - 8° livello")] };
  const { inCorso, concluse } = clientProgramList({ snapshot, active, versions: [], today: "2026-11-20" });
  assert.equal(inCorso[0].done, 1);
  assert.deepEqual(concluse.map(r => [r.name, r.published, r.done]), [["M - 8° livello", false, 2]]);
});
