const test = require("node:test");
const assert = require("node:assert/strict");

let metrics;
test.before(async () => { metrics = await import("../www/src/workout-metrics.mjs"); });

test("converte il vecchio JSON in v2 senza perdere l'originale e interpreta carichi e ripetizioni", () => {
  const legacy = {
    nome: "Full body", dal: "2026-01-01", al: "2026-01-14",
    settimane: [{ giorni: [{ nome: "A", esercizi: [
      { nome: "Panca", serie: 3, reps: "8-10", rec: "1:30", carico: "60 kg", note: "Controllata" },
      { nome: "Alzate", serie: 1, reps: "AMRAP", rec: "90", carico: "-15%" },
      { nome: "Plank", serie: 2, reps: "30s", carico: "PC" }
    ] }] }]
  };
  const v2 = metrics.convertLegacyProgram(legacy);
  assert.equal(v2.schemaVersion, 2);
  assert.deepEqual(v2.legacyBackup, legacy);
  const exercises = v2.settimane[0].giorni[0].blocks.map((block) => block.exercises[0]);
  assert.equal(exercises[0].sets[0].reps_min, 8);
  assert.equal(exercises[0].sets[0].reps_max, 10);
  assert.equal(exercises[0].sets[0].load_value, 60);
  assert.equal(exercises[0].sets[0].rest_seconds, 90);
  assert.equal(exercises[1].sets[0].reps_mode, "amrap");
  assert.equal(exercises[1].sets[0].load_unit, "percent_of_top");
  assert.equal(exercises[2].sets[0].reps_mode, "time");
  assert.equal(exercises[2].sets[0].load_unit, "bodyweight");
  assert.deepEqual(metrics.convertLegacyProgram(v2), v2);
});

test("conta le serie utili escludendo i riscaldamenti e assegna correttamente le serie di superserie", () => {
  const workout = { blocks: [{ method: "superset", exercises: [
    { id: "a", sets: [{ set_type: "warmup" }, { set_type: "working" }, { set_type: "working" }] },
    { id: "b", sets: [{ set_type: "working" }, { set_type: "working" }] }
  ] }] };
  assert.equal(metrics.calculateUsefulSets(workout), 4);
  assert.equal(metrics.calculateUsefulSets(workout, { usefulSetWeights: { working: 1, warmup: 0, drop: 0.5 } }), 4);
});

test("stima durata di un superset, arrotonda a 5 minuti e non aggiunge recupero dopo l'ultimo giro", () => {
  const set = (round) => ({ round, set_type: "working", reps_min: 8, reps_max: 8, reps_mode: "range", tempo: "1-0-1-0", rest_seconds: 60 });
  const workout = { blocks: [{ method: "superset", rest_after_seconds: 60, exercises: [
    { id: "a", equipment: "panca", sets: [set(1), set(2)] },
    { id: "b", equipment: "panca", sets: [set(1), set(2)] }
  ] }] };
  const result = metrics.estimateWorkout(workout);
  assert.equal(result.seconds, 259);
  assert.equal(result.minutes, 5);
  assert.equal(result.exceedsAvailability, false);
});

test("stima AMRAP, tempo mancante e isometrie senza confondere secondi e ripetizioni", () => {
  const settings = { ...metrics.DEFAULT_WORKOUT_SETTINGS, amrapReps: 10 };
  const amrap = { available_minutes: 1, blocks: [{ method: "straight", exercises: [{ id: "a", sets: [{ set_type: "failure", reps_mode: "amrap", target_rir: 0 }] }] }] };
  const timed = { blocks: [{ method: "isometric", exercises: [{ id: "b", sets: [{ set_type: "working", reps_mode: "time", reps_min: 30, reps_max: 30 }] }] }] };
  assert.equal(metrics.estimateWorkout(amrap, settings).estimatedReps, true);
  assert.equal(metrics.estimateWorkout(amrap, settings).exceedsAvailability, true);
  assert.equal(metrics.estimateWorkout(timed, settings).seconds, 30);
});

test("calcola media RIR/RPE, volume primario e secondario, barre e copertura date", () => {
  const workout = { blocks: [{ method: "straight", exercises: [{ id: "a", primary_muscles: ["petto"], secondary_muscles: ["tricipiti"], sets: [
    { set_type: "warmup", target_rir: 4 }, { set_type: "working", target_rir: 2 }, { set_type: "working", target_rir: 4 }
  ] }] }] };
  assert.deepEqual(metrics.calculateAverageRir(workout), { rir: 3, display: 3, scale: "RIR" });
  assert.equal(metrics.calculateAverageRir(workout, "RPE").display, 7);
  const volume = metrics.calculateVolume({ giorni: [workout] });
  assert.equal(volume.totals.petto, 2);
  assert.equal(volume.totals.tricipiti, 1);
  const program = { dal: "2026-01-01", al: "2026-01-28", settimane: [{ giorni: [workout] }, { giorni: [workout] }] };
  assert.deepEqual(metrics.inspectProgramDates(program).warnings.map((warning) => warning.path), ["settimane"]);
  assert.deepEqual(metrics.calculateWeekBars(program).map((bar) => bar.volume), [1, 1]);
});

test("le date calendario coprono periodi da 7 o 8 giorni, settimane parziali, DST e confini di mese e anno", () => {
  const period = (dal, al, settimane) => metrics.inspectProgramDates({ dal, al, settimane });
  assert.deepEqual(period("2026-11-10", "2026-11-16", [{}]), { errors: [], warnings: [] });
  assert.deepEqual(period("2026-11-10", "2026-11-17", [{ dal: "2026-11-10", al: "2026-11-17", dates_are_manual: true }]), { errors: [], warnings: [] });
  assert.deepEqual(period("2026-11-10", "2026-11-17", [{}, {}]), { errors: [], warnings: [] });
  assert.ok(period("2026-11-10", "2026-11-17", [{ dal: "2026-11-10", al: "2026-11-16", dates_are_manual: true }]).warnings.some(({ message }) => message.includes("non coprono tutto")));
  assert.deepEqual(period("2026-03-25", "2026-04-07", [{}, {}]), { errors: [], warnings: [] }); // comprende il cambio d'ora legale
  assert.deepEqual(period("2026-12-28", "2027-01-03", [{}]), { errors: [], warnings: [] });
  assert.ok(metrics.inspectProgramDates({ dal: "2026-02-30", al: "2026-03-01", settimane: [{}] }).errors.length);
});

test("normalizza maiuscole, accenti e sinonimi dei muscoli senza conteggiare due volte il gruppo primario", () => {
  assert.equal(metrics.normalizeMuscleName("PETTORALI"), "petto");
  assert.equal(metrics.normalizeMuscleName("Gràn Dorsale"), "schiena");
  const workout = { blocks: [{ method: "straight", exercises: [{ primary_muscles: ["Petto", "pettorale"], secondary_muscles: ["pettorali", "Trìcipite"], sets: [{ set_type: "working" }] }] }] };
  const volume = metrics.calculateVolume({ giorni: [workout] });
  assert.equal(volume.totals.petto, 1);
  assert.equal(volume.totals.tricipiti, 0.5);
});

test("la barra d'intensità usa la media di tutte le serie utili della settimana", () => {
  const day = (rirValues) => ({ blocks: [{ method: "straight", exercises: [{ id: "a", sets: rirValues.map((target_rir, index) => ({ set_type: "working", target_rir, position: index + 1 })) }] }] });
  const bars = metrics.calculateWeekBars({ settimane: [{ giorni: [day([0]), day([5, 5, 5])] }] });
  assert.equal(bars[0].meanRpe, 6.25);
});

test("ricalcola i riepiloghi derivati della scheda partendo dalle prescrizioni", () => {
  const program = metrics.convertLegacyProgram({ nome: "Piano", settimane: [{ giorni: [{ esercizi: [{ nome: "Squat", serie: 2, reps: "8", carico: "60", rec: 60, primary_muscles: ["quadricipiti"] }] }] }] });
  program.calculated = { totals: { usefulSets: 999 } };
  const saved = metrics.validateV2Program(program);
  assert.equal(saved.valid, true);
  assert.equal(saved.program.calculated.totals.usefulSets, 2);
  assert.equal(saved.program.calculated.weeks[0].workouts[0].durationMinutes, 5);
  assert.equal(saved.program.calculated.weeks[0].volume.quadricipiti, 2);
});

test("importa il formato esteso non versionato con metodi, righe di serie e gruppi", () => {
  const imported = metrics.convertImportedProgram({
    nome: "Forza", settimane: [{ giorni: [{ esercizi: [
      { nome: "Panca", metodo: "top_back_off", serie: [
        { tipo: "riscaldamento", reps: "8", carico: "40" },
        { tipo: "top", reps: "5", carico: "80", rir: 2 },
        { tipo: "back_off", reps: "8", carico: "-15%", rir: 3 }
      ] },
      { nome: "Rematore", metodo: "superset", gruppo: "A", serie: [{ reps: "10", carico: "50" }] },
      { nome: "Face pull", metodo: "superset", gruppo: "A", serie: [{ reps: "12", carico: "20" }] }
    ] }] }]
  });
  assert.equal(imported.valid, true);
  const blocks = imported.program.settimane[0].giorni[0].blocks;
  assert.equal(blocks[0].method, "top_back_off");
  assert.equal(blocks[0].exercises[0].sets[2].load_unit, "percent_of_top");
  assert.equal(blocks[0].exercises[0].sets[1].target_rir, 2);
  assert.equal(blocks[1].method, "superset");
  assert.equal(blocks[1].exercises.length, 2);
  assert.ok(imported.program.legacyBackup);
});

test("converte l'intensità RPE importata in RIR senza cambiare l'esercizio", () => {
  const imported = metrics.convertImportedProgram({ intensity_scale: "RPE", settimane: [{ giorni: [{ esercizi: [{ nome: "Panca", serie: [{ reps: "8", rpe: 8 }] }] }] }] });
  assert.equal(imported.valid, true);
  assert.equal(imported.program.settimane[0].giorni[0].blocks[0].exercises[0].sets[0].target_rir, 2);
});

test("importa il formato storico senza titolo e segnala gli oggetti malformati con il percorso", () => {
  const imported = metrics.convertImportedProgram({ settimane: [{ giorni: [{ esercizi: [{ nome: "Squat", serie: 2, reps: "8", carico: "60" }] }] }] });
  assert.equal(imported.valid, true);
  assert.equal(imported.program.nome, "Scheda importata");
  assert.equal(metrics.validateV2Program(imported.program).valid, true);
  const reloaded = metrics.convertImportedProgram(imported.program);
  assert.equal(reloaded.valid, true);
  assert.deepEqual(reloaded.program, imported.program, "un secondo caricamento deve restituire lo stesso documento e gli stessi riepiloghi");
  const invalid = metrics.convertImportedProgram({ settimane: [{ giorni: [null] }] });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors[0].path, "settimane[0].giorni[0]");
});

test("il validatore evidenzia il percorso della serie e blocca prescrizioni incomplete in pubblicazione", () => {
  const program = metrics.convertLegacyProgram({ nome: "Piano", dal: "2026-01-01", al: "2026-01-07", settimane: [{ giorni: [{ esercizi: [{ nome: "Squat", serie: 1, reps: "8-6" }] }] }] });
  const result = metrics.validateV2Program(program, { forPublish: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path.endsWith(".reps")));
  assert.ok(result.errors.some((error) => error.path.endsWith(".load")));
});

test("le bozze incomplete possono essere salvate ma la pubblicazione blocca i campi mancanti", () => {
  const program = metrics.convertLegacyProgram({ nome: "Bozza incompleta", settimane: [{ giorni: [{ esercizi: [{ nome: "Squat", serie: 1 }] }] }] });
  const draft = metrics.validateV2Program(program);
  const published = metrics.validateV2Program(program, { forPublish: true });
  assert.equal(draft.valid, true);
  assert.equal(published.valid, false);
  assert.ok(published.errors.some(({ path }) => path === "dal/al"));
  assert.ok(published.errors.some(({ path }) => path.endsWith(".reps")));
  assert.ok(published.errors.some(({ path }) => path.endsWith(".load")));
});

test("il programma v2 viene tradotto per Workout mantenendo serie speciali e specifiche per riga", () => {
  const program = metrics.convertLegacyProgram({ nome: "Piano", dal: "2026-01-01", al: "2026-01-07", settimane: [{ giorni: [{ esercizi: [] }] }] });
  const workout = program.settimane[0].giorni[0];
  workout.title = "Spinta"; workout.weekday = 1; workout.blocks = [{ id: "block-a", position: 1, method: "drop_set", rest_after_seconds: 90, exercises: [{
    id: "exercise-a", position: 1, name: "Panca", primary_muscles: ["Petto"], equipment: "Bilanciere", sets: [
      { id: "s1", position: 1, set_type: "working", reps_min: 8, reps_max: 10, reps_mode: "range", load_value: 60, load_unit: "kg", target_rir: 2, rest_seconds: 90 },
      { id: "s2", position: 2, set_type: "drop", reps_min: 8, reps_max: 8, reps_mode: "range", load_value: -25, load_unit: "percent_of_top", target_rir: 1, rest_seconds: 0 }
    ]
  }] }];
  const athlete = metrics.toAthleteProgram(program);
  const exercise = athlete.settimane[0].giorni[0].esercizi[0];
  assert.equal(exercise.nome, "Panca");
  assert.equal(exercise.serie, 2);
  assert.deepEqual(exercise.repsSerie, ["8-10", "8"]);
  assert.deepEqual(exercise.carichiSerie, ["60", "-25%"]);
  assert.equal(exercise.prescriptions[1].set_type, "drop");
  assert.equal(exercise.muscolo, "Petto");
});
