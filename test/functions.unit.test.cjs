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
  assert.equal(program.settimane[0].giorni[0].esercizi[0].serie, 4);
});

test("rifiuta schede vuote o con periodi invertiti", () => {
  assert.throws(() => validateProgram({ nome: "X", dal: "2026-12-10", al: "2026-11-10", settimane: [] }));
  assert.throws(() => validateProgram({ nome: "X", dal: "2026-11-10", al: "2026-12-10", settimane: [{ giorni: [] }] }));
});
