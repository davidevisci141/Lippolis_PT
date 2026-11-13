const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const editor = import("../www/src/coach-mockup-model.mjs");
const runtime = import("../www/src/workout-metrics.mjs");
const dates = { dal: "2026-11-13", al: "2026-11-19" };
const exercise = { nome: "Squat", serie: "3", rip: "8-10", rec: "01:30", rir: "2", carico: "40", note: "Pausa in basso" };
const template = (...esercizi) => ({
  nome: "Full body",
  weeks: [{ nome: "Settimana 1", giorni: [{ nome: "Gambe", giorno: "1", esercizi }] }]
});

test("la home PT integra il calendario e mantiene la scheda cliente e i due editor", () => {
  const html = fs.readFileSync(path.join(__dirname, "../www/coach.html"), "utf8");
  for (const tile of ["priorita", "clienti", "workout", "nutrizione"]) {
    assert.match(html, new RegExp(`id:'${tile}'`));
  }
  assert.doesNotMatch(html, /id:'(?:revisione|abbonamenti|agenda|impostazioni)'/);
  assert.match(html, /id="coachSettings"/);
  assert.match(html, /id="pdDelete".*Elimina giornata/);
  assert.match(html, /id="homeCalendar"/);
  assert.match(html, /id="calAdd"/);
  for (const field of ["copyWk", "addWk", "addDay", "assignMockProgram", "assignPiano", "savePianoDraft", "pdDelete", "impBtn", "impPiano", "addEx"]) {
    assert.match(html, new RegExp(`id="${field}"`));
  }
  assert.match(html, /coach-mockup\.mjs/);
  assert.doesNotMatch(html, /Salvataggio automatico \(localStorage\)|142 clienti|800 programmi/);
});

test("salva e rilegge prescrizioni, istruzioni, video privato e superserie", async () => {
  const { mockupToProgram, programToMockup } = await editor;
  const { toAthleteProgram } = await runtime;
  const { validateProgram } = await import("../supabase/functions/_shared/validation.mjs");
  const program = mockupToProgram(template(exercise, {
    ...exercise, nome: "Affondi", link: "superserie", videoStoragePath: "coach/video.mp4", descrizione: "Controlla l’appoggio", note: "Alterna i lati"
  }), dates);
  const published = validateProgram(JSON.parse(JSON.stringify(program)), { forPublish: true });
  const day = toAthleteProgram(published).settimane[0].giorni[0];
  assert.equal(day.esercizi[0].rec, "90");
  assert.equal(day.esercizi[0].prescriptions[0].load_value, 40);
  assert.equal(day.esercizi[0].prescriptions[0].target_rir, 2);
  assert.equal(day.esercizi[0].ss, day.esercizi[1].ss);
  assert.equal(day.esercizi[1].videoStoragePath, "coach/video.mp4");
  assert.equal(day.esercizi[1].instructions, "Controlla l’appoggio");
  assert.equal(day.esercizi[0].note, "Pausa in basso");
  assert.equal(day.esercizi[1].note, "Alterna i lati\nControlla l’appoggio");
  const reopened = programToMockup(published).weeks[0].giorni[0].esercizi;
  assert.equal(reopened[1].link, "superserie");
  assert.equal(reopened[1].note, "Alterna i lati");
  assert.equal(reopened[0].carico, "40");
  assert.equal(reopened[0].rip, "8-10");
});

test("l'importazione a tempo registra secondi e l'editor blocca le prescrizioni incomplete", async () => {
  const { mockupToProgram } = await editor;
  const { toAthleteProgram } = await runtime;
  const program = mockupToProgram(template({ ...exercise, tipo: "tempo", rip: "01:20", carico: "PC" }), dates);
  const timed = toAthleteProgram(program).settimane[0].giorni[0].esercizi[0];
  assert.equal(timed.unita, "sec");
  assert.equal(timed.prescriptions[0].reps_min, 80);
  assert.throws(() => mockupToProgram(template({ ...exercise, serie: "" }), dates), /numero di serie/);
  assert.throws(() => mockupToProgram(template({ ...exercise, video: "http://example.test/video.mp4" }), dates), /Video non valido/);
});
