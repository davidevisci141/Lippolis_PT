const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.resolve(__dirname, "../www/athlete.html"), "utf8");
const start = page.indexOf("  function dentroSettimana(");
const end = page.indexOf("  function giornoFatto(");
assert.ok(start > 0 && end > start, "funzioni non trovate in athlete.html");
const source = page.slice(start, end);

function load({ sessioni, versione = "v-20" }) {
  const PROGRAMMA = {
    nome: "Vittorio Lippolis - 20° livello",
    settimane: [
      { n: 1, dal: "2026-10-26", al: "2026-11-01", giorni: [{}, {}, {}, {}] },
      { n: 2, dal: "2026-11-02", al: "2026-11-08", giorni: [{}, {}, {}, {}] },
    ],
  };
  const ctx = { PROGRAMMA, sessioni, versioneSchedaLocale: versione, settCorr: 0, senzaScheda: () => false };
  return vm.runInNewContext(source + "\n({sessioneDelGiorno})", ctx);
}
const ts = (iso) => new Date(iso + "T18:00:00").getTime();

test("una sessione importata dello stesso programma, nella sua settimana, conta come seduta svolta", () => {
  const { sessioneDelGiorno } = load({ sessioni: [
    { id: "a", importata: true, prog: "Vittorio Lippolis - 20° livello", settimana: 1, giorno: 0, ts: ts("2026-10-26") },
  ] });
  assert.equal(sessioneDelGiorno(0, 0)?.id, "a");
  assert.equal(sessioneDelGiorno(1, 0), null);
});

test("una sessione importata di un altro programma non conta", () => {
  const { sessioneDelGiorno } = load({ sessioni: [
    { id: "b", importata: true, prog: "Vittorio Lippolis - 19° livello", settimana: 1, giorno: 0, ts: ts("2026-10-26") },
  ] });
  assert.equal(sessioneDelGiorno(0, 0), null);
});

test("una sessione importata con lo stesso nome ma fuori dalle date della settimana non conta", () => {
  const { sessioneDelGiorno } = load({ sessioni: [
    { id: "c", importata: true, prog: "Vittorio Lippolis - 20° livello", settimana: 1, giorno: 0, ts: ts("2025-10-27") },
  ] });
  assert.equal(sessioneDelGiorno(0, 0), null);
});

test("le sessioni registrate nell'app continuano a contare solo con la loro versione di scheda", () => {
  const { sessioneDelGiorno } = load({ sessioni: [
    { id: "d", programVersionId: "v-20", prog: "Vittorio Lippolis - 20° livello", settimana: 2, giorno: 1, ts: ts("2026-11-03") },
    { id: "e", programVersionId: "v-vecchia", prog: "Vittorio Lippolis - 20° livello", settimana: 2, giorno: 2, ts: ts("2026-11-04") },
  ] });
  assert.equal(sessioneDelGiorno(1, 1)?.id, "d");
  assert.equal(sessioneDelGiorno(2, 1), null);
});
