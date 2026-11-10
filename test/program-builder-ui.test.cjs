const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "www/coach.html"), "utf8");
const builder = fs.readFileSync(path.join(root, "www/src/program-builder.mjs"), "utf8");
const coach = fs.readFileSync(path.join(root, "www/src/coach.mjs"), "utf8");

test("l'editor espone una sola scala, target vuoti, range leggibili e intensità distinta dal volume", () => {
  assert.equal((html.match(/id="programScaleToggle"/g) || []).length, 1);
  assert.match(builder, /volume_target: null, intensity_target: null/);
  assert.match(builder, /<span>Min<\/span><span>Max<\/span>/);
  assert.match(builder, /Intensità · \$\{bars\[index\]\.scale\}/);
  assert.match(builder, /Durata massima \(min\)/);
});

test("note e dati dell'esercizio sono comprimibili e prevedono suggerimenti e riepilogo", () => {
  assert.match(builder, /<details class="pb-notes"/);
  assert.match(builder, /data-has-note/);
  assert.match(builder, /list="pbExerciseLibrary"/);
  assert.match(builder, /list="pbMuscleLibrary"/);
  assert.match(builder, /Modifica muscoli e attrezzo/);
  assert.match(builder, /esercizio personalizzato/);
});

test("bozze e versioni offrono ripresa, archiviazione reversibile, anteprima e ripristino non distruttivo", () => {
  assert.match(coach, /data-draft-resume/);
  assert.match(coach, /data-draft-archive/);
  assert.match(coach, /I dati restano conservati/);
  assert.match(coach, /data-version-preview/);
  assert.match(coach, /data-version-restore/);
  assert.match(coach, /La versione attiva resterà invariata/);
  assert.match(coach, /Pubblicata il \$\{when\(version\.publishedAt\)\}/);
  assert.doesNotMatch(coach, /<small>\$\{esc\(version\.versionId/);
});

test("lo stato pubblicazione è separato dall'esito del salvataggio e le risorse hanno cache-busting coerente", () => {
  assert.match(html, /id="programStatus"/);
  assert.match(coach, /Modifiche non pubblicate/);
  assert.match(coach, /Pubblicata \(v\$\{state\.currentProgram\.revision/);
  assert.match(coach, /Salvato alle/);
  const queryVersions = [...html.matchAll(/program-v(\d+)/g), ...coach.matchAll(/program-v(\d+)/g), ...builder.matchAll(/program-v(\d+)/g)].map((match) => match[1]);
  assert.ok(queryVersions.length > 0);
  assert.equal(new Set(queryVersions).size, 1);
});

test("i blocchi restano compatti e si apre il blocco da compilare", () => {
  assert.match(builder, /<details class="pb-block" data-block-id=/);
  assert.match(builder, /#openFirstBlock\(\)/);
  assert.match(builder, /this\.openBlocks\.clear\(\); this\.openBlocks\.add\(block\.id\)/);
  assert.match(builder, /this\.openBlocks\.add\(copy\.id\)/);
  assert.match(html, /\.pb-block-content>header\{display:flex;flex-wrap:nowrap/);
  assert.match(html, /@media\(max-width:520px\)\{\.pb-block>summary/);
});

test("gli strumenti laterali hanno schede separate per libreria, volume e progressione", () => {
  assert.match(builder, /\[\["library", "Libreria"\], \["volume", "Volume"\], \["progression", "Progressione"\]\]/);
  assert.match(builder, /data-action="select-tool-panel"/);
  assert.match(builder, /id="pbToolLibrary"/);
  assert.match(builder, /id="pbToolVolume"/);
  assert.match(builder, /id="pbToolProgression"/);
  assert.match(builder, /exerciseCatalog\.values\(\)/);
});
