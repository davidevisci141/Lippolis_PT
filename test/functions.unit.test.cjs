"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
let validateCreateClient;
let validateProgram;

test.before(async () => {
  ({ validateCreateClient, validateProgram } = await import("../supabase/functions/_shared/validation.mjs"));
});

test("valida e normalizza la creazione cliente", () => {
  const value = validateCreateClient({
    firstName: "  Mario ", lastName: " Rossi  ", email: "MARIO@example.com",
    password: "PasswordSicura7!", idempotencyKey: "abcdef0123456789"
  });
  assert.equal(value.firstName, "Mario");
  assert.equal(value.lastName, "Rossi");
  assert.equal(value.email, "mario@example.com");
});

test("rifiuta password debole, email errata e chiave idempotenza corta", () => {
  assert.throws(() => validateCreateClient({ firstName: "A", lastName: "B", email: "no", password: "corta", idempotencyKey: "x" }));
  assert.throws(() => validateCreateClient({ firstName: "A", lastName: "B", email: "a@b.it", password: "tuttominuscolo123", idempotencyKey: "abcdef0123456789" }));
});

test("normalizza settimane, giorni ed esercizi della scheda", () => {
  const program = validateProgram({
    nome: "Forza 1", dal: "2026-11-10", al: "2026-12-10",
    settimane: [{ giorni: [{ titolo: "A", esercizi: [{ nome: "Squat", serie: 4, reps: "5", rec: "120" }] }] }]
  });
  assert.equal(program.nome, "Forza 1");
  assert.equal(program.settimane[0].n, 1);
  assert.equal(program.settimane[0].dal, "2026-11-10");
  assert.equal(program.settimane[0].al, "2026-12-10");
  assert.ok(program.settimane[0].giorni[0].min > 0);
  assert.equal(program.settimane[0].giorni[0].dt, "A");
  assert.equal(program.settimane[0].giorni[0].esercizi[0].serie, 4);
});

test("suddivide le date del programma tra le settimane e rifiuta intervalli incoerenti", () => {
  const program = validateProgram({
    nome: "Forza 2", dal: "2026-11-10", al: "2026-11-23",
    settimane: [
      { giorni: [{ esercizi: [{ nome: "Squat", serie: 3 }] }] },
      { giorni: [{ esercizi: [{ nome: "Panca", serie: 3 }] }] }
    ]
  });
  assert.deepEqual(program.settimane.map(({ dal, al }) => [dal, al]), [["2026-11-10", "2026-11-16"], ["2026-11-17", "2026-11-23"]]);
  assert.throws(() => validateProgram({ nome: "X", dal: "2026-02-30", al: "2026-03-10", settimane: [{ giorni: [{ esercizi: [{ nome: "A", serie: 1 }] }] }] }));
  assert.throws(() => validateProgram({ nome: "X", dal: "2026-11-10", al: "2026-11-23", settimane: [{ dal: "2026-11-10", al: "2026-11-15", giorni: [{ esercizi: [{ nome: "A", serie: 1 }] }] }, { dal: "2026-11-17", al: "2026-11-23", giorni: [{ esercizi: [{ nome: "B", serie: 1 }] }] }] }));
});

test("rifiuta schede vuote o con periodi invertiti", () => {
  assert.throws(() => validateProgram({ nome: "X", dal: "2026-12-10", al: "2026-11-10", settimane: [] }));
  assert.throws(() => validateProgram({ nome: "X", dal: "2026-11-10", al: "2026-12-10", settimane: [{ giorni: [] }] }));
});

test("il validatore usato dal server sostituisce i totali inviati dal browser con i calcoli verificati", () => {
  const program = validateProgram({
    schemaVersion: 2, nome: "Scheda", dal: "2026-11-10", al: "2026-11-16",
    settimane: [{ giorni: [{ title: "A", blocks: [{ method: "straight", exercises: [{ name: "Squat", primary_muscles: ["quadricipiti"], sets: [
      { set_type: "working", reps_min: 8, reps_max: 8, reps_mode: "range", load_value: 60, load_unit: "kg" },
      { set_type: "working", reps_min: 8, reps_max: 8, reps_mode: "range", load_value: 60, load_unit: "kg" }
    ] }] }] }] }],
    calculated: { totals: { usefulSets: 1000 } }
  });
  assert.equal(program.calculated.totals.usefulSets, 2);
  assert.equal(program.calculated.weeks[0].volume.quadricipiti, 2);
});
