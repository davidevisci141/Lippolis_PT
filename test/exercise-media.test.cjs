const test = require("node:test");
const assert = require("node:assert/strict");

const mediaModule = import("../www/src/exercise-video.mjs");
const builderModule = import("../www/src/program-builder.mjs");
const modelModule = import("../www/src/workout-metrics.mjs");

test("i link video producono una sorgente coerente con il servizio", async () => {
  const { parseExerciseVideo } = await mediaModule;
  assert.deepEqual(parseExerciseVideo(" https://youtu.be/dQw4w9WgXcQ?t=10 "), {
    kind: "youtube",
    url: "https://youtu.be/dQw4w9WgXcQ?t=10",
    embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
  });
  assert.equal(parseExerciseVideo("https://vimeo.com/123456789/a1bc")?.embedUrl, "https://player.vimeo.com/video/123456789?h=a1bc");
  assert.deepEqual(parseExerciseVideo("https://media.example.com/press.MP4?token=test"), {
    kind: "file",
    url: "https://media.example.com/press.MP4?token=test",
    embedUrl: null
  });
  for (const url of [
    "javascript:alert(1)",
    "http://example.com/press.mp4",
    "https://user:password@media.example.com/press.webm",
    "https://youtube.com.example.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/playlist?list=dQw4w9WgXcQ",
    "https://player.vimeo.com/video/123?h=a%26other%3Dyes"
  ]) assert.equal(parseExerciseVideo(url), null, url);
});

function setupRoot() {
  const handlers = new Map();
  const root = {
    isConnected: false,
    addEventListener: (name, handler) => handlers.set(name, handler),
    querySelectorAll: () => [],
    querySelector: () => null
  };
  const dispatch = (type, dataset, value = "") => {
    const attributes = {};
    const feedback = { dataset: {}, textContent: "" };
    const status = { textContent: "" };
    const panel = { querySelector: (selector) => selector === ".pb-video-feedback" ? feedback : status };
    const target = {
      dataset, value, tagName: "INPUT", type: "text",
      setAttribute: (name, attributeValue) => { attributes[name] = attributeValue; },
      setCustomValidity: (message) => { attributes.validationMessage = message; },
      closest: (selector) => selector === ".pb-exercise-media" ? panel : target
    };
    handlers.get(type)({ target });
    return { attributes, feedback, status };
  };
  return { root, dispatch };
}

const athleteExercise = (program) => program.settimane[0].giorni[0].esercizi[0];
const modelExercise = (program) => program.settimane[0].giorni[0].blocks[0].exercises[0];
const createProgram = (convertLegacyProgram) => convertLegacyProgram({
  nome: "Scheda", dal: "2026-11-09", al: "2026-11-15",
  settimane: [{ n: 1, giorni: [
    { titolo: "Prima seduta", esercizi: [{ nome: "Panca", serie: 2, reps: "8", carico: "30" }] },
    { titolo: "Seconda seduta", esercizi: [{ nome: "Rematore", serie: 2, reps: "8", carico: "30" }] }
  ] }]
});

test("istruzioni e video passano dall’editor alla scheda dell’atleta", async () => {
  const [{ ProgramBuilder }, { convertLegacyProgram, validateV2Program, toAthleteProgram }] = await Promise.all([builderModule, modelModule]);
  const { root, dispatch } = setupRoot();
  const builder = new ProgramBuilder(root);
  builder.setProgram(createProgram(convertLegacyProgram));
  const input = { b: "0", e: "0" };

  dispatch("input", { ...input, field: "exercise.instructions" }, "Tieni le scapole stabili.");
  const invalid = dispatch("input", { ...input, field: "exercise.video_ref" }, "https://example.com/pagina");
  assert.equal(invalid.attributes["aria-invalid"], "true");
  assert.match(invalid.attributes.validationMessage, /HTTPS/);
  assert.ok(validateV2Program(builder.getProgram()).errors.some((error) => error.path.endsWith(".video_ref")));

  const link = "https://media.example.com/press.webm";
  const valid = dispatch("input", { ...input, field: "exercise.video_ref" }, link);
  assert.equal(valid.attributes["aria-invalid"], "false");
  const saved = validateV2Program(builder.getProgram());
  assert.equal(saved.valid, true);
  const exercise = athleteExercise(toAthleteProgram(saved.program));
  assert.equal(exercise.instructions, "Tieni le scapole stabili.");
  assert.equal(exercise.video_ref, link);
});

test("la libreria ripropone il video mantenendo le istruzioni inserite nella seduta", async () => {
  const [{ ProgramBuilder }, { convertLegacyProgram }] = await Promise.all([builderModule, modelModule]);
  const { root, dispatch } = setupRoot();
  const builder = new ProgramBuilder(root);
  const program = createProgram(convertLegacyProgram);
  const original = modelExercise(program);
  original.instructions = "Istruzioni della prima seduta";
  original.video_ref = "https://youtu.be/dQw4w9WgXcQ";
  const target = program.settimane[0].giorni[1].blocks[0].exercises[0];
  target.instructions = "Istruzioni personalizzate";
  builder.setProgram(program);

  dispatch("click", { action: "select-day", d: "1" });
  dispatch("change", { field: "exercise.name", b: "0", e: "0" }, "  panca ");
  const saved = builder.getProgram().settimane[0].giorni[1].blocks[0].exercises[0];
  assert.equal(saved.name, "panca");
  assert.equal(saved.video_ref, original.video_ref);
  assert.equal(saved.instructions, target.instructions);
});

test("copiando una settimana o un blocco tra sedute si generano ID indipendenti", async () => {
  const [{ ProgramBuilder }, { convertLegacyProgram }] = await Promise.all([builderModule, modelModule]);
  const { root, dispatch } = setupRoot();
  const builder = new ProgramBuilder(root);
  const program = createProgram(convertLegacyProgram);
  modelExercise(program).instructions = "Controlla la discesa.";
  builder.setProgram(program);

  dispatch("click", { action: "copy-block-to-day", b: "0", d: "1" });
  const copy = builder.getProgram().settimane[0].giorni[1].blocks[1];
  assert.notEqual(copy.id, program.settimane[0].giorni[0].blocks[0].id);
  assert.notEqual(copy.exercises[0].id, modelExercise(program).id);
  assert.equal(copy.exercises[0].instructions, "Controlla la discesa.");

  dispatch("click", { action: "duplicate-week" });
  const [original, duplicate] = builder.getProgram().settimane;
  assert.notEqual(duplicate.id, original.id);
  assert.notEqual(duplicate.giorni[1].blocks[1].id, original.giorni[1].blocks[1].id);
  assert.notEqual(duplicate.giorni[1].blocks[1].exercises[0].sets[0].id, original.giorni[1].blocks[1].exercises[0].sets[0].id);
});
