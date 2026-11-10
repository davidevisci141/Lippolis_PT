const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const athleteModule = fs.readFileSync(path.join(root, "www/src/athlete.mjs"), "utf8");
const athletePage = fs.readFileSync(path.join(root, "www/athlete.html"), "utf8");

test("la sincronizzazione atleta applica gli aggiornamenti senza ricaricare la pagina", () => {
  assert.doesNotMatch(athleteModule, /location\.reload\s*\(/);
  assert.match(athleteModule, /api\.applySnapshot\(mergeRemote\(value\.snapshot, null, profile\)\)/);
  assert.match(athleteModule, /api\.applySnapshot\(mergeRemote\(null, value \|\| false, profile\)\)/);
  assert.match(athletePage, /applySnapshot:\s*\(value\)=>/);
  assert.match(athletePage, /switchAccount:\s*\(uid\)=>/);
});
