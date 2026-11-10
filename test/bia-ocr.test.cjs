const test = require("node:test");
const assert = require("node:assert/strict");

const dimensions = { width: 1000, height: 1100 };
const items = [];
function box(text, x, y, width = Math.max(24, String(text).length * 7), score = 0.99) {
  items.push({ text, score, poly: [[x, y], [x + width, y], [x + width, y + 12], [x, y + 12]] });
}
function sameRow(label, value, y, labelX = 25, valueX = 480, score = 0.99) { box(label, labelX, y, undefined, score); box(value, valueX, y, 55, score); }
function below(label, value, labelX, y, valueX = labelX, score = 0.99) { box(label, labelX, y); box(value, valueX, y + 16, 55, score); }

box("InBody120", 820, 12);
box("ID", 25, 55); box("061224-2", 25, 72, 60);
below("Altezza", "178", 195, 55, 195);
below("Età", "23", 315, 55, 315);
below("Genere", "Maschio", 405, 55, 405);
below("Data Test Ora", "04.11.2026 18:37", 510, 55, 510, 0.98);
box("Analisi della Composizione Corporea", 25, 145, 260);
sameRow("Acqua Corporea Totale", "49,2", 175);
sameRow("Proteine", "13,5", 195);
sameRow("Minerali", "4,64", 215);
sameRow("Massa Grassa del Corpo", "17,6", 235);
sameRow("Peso", "84,9", 255);
box("Analisi Muscolo - Grasso", 25, 282, 220);
below("Massa del Muscolo Scheletrico", "38,6", 70, 308, 480);
box("Analisi dell'obesità", 25, 355, 190);
below("IMC", "26,8", 60, 380, 480);
below("Percentuale di Grasso Corporeo", "20,7", 60, 420, 480);
box("Punteggio InBody", 710, 470, 140); box("82", 760, 490, 30);
box("Controllo del Peso", 700, 520, 150);
sameRow("Peso Target", "79,2", 545, 710, 850);
sameRow("Controllo del Peso", "-5,7", 565, 710, 850);
sameRow("Controllo del Grasso", "-5,7", 585, 710, 850);
sameRow("Controllo del Muscolo", "0,0", 605, 710, 900);
box("Parametri di Ricerca", 680, 645, 160);
sameRow("Tasso Metabolico Basale", "1823", 665, 700, 900);
sameRow("Relazione Cintura Fianchi", "0,90", 685, 700, 900);
sameRow("Livello Grasso Viscerale", "7", 705, 700, 900);
sameRow("Grado di obesità", "122 %", 725, 700, 900);
box("Interpretazione dei risultati", 700, 765, 180);
box("Storia della Composizione Corporea", 25, 820, 250);
box("Peso", 25, 842); box("86,4", 150, 842); box("88,2", 250, 842); box("86,0", 350, 842); box("84,3", 450, 842); box("84,9", 550, 842);
box("Massa del Muscolo Scheletrico", 25, 872, 150); box("37,8", 150, 872); box("38,7", 250, 872); box("39,0", 350, 872); box("39,9", 450, 872); box("38,6", 550, 872);
box("Percentuale di Grasso Corporeo", 25, 902, 160); box("23,9", 150, 902); box("23,7", 250, 902); box("21,3", 350, 902); box("17,7", 450, 902); box("20,7", 550, 902);
for (const [x, date] of [[150, "06.12.24"], [250, "13.02.25"], [350, "09.04.25"], [450, "18.06.25"], [550, "04.11.26"]]) box(date, x, 932, 60);
box("18:37", 560, 948, 36);

let parser;
async function getParser() { return parser ||= await import("../www/src/bia-ocr.mjs"); }

test("normalizza i formati numerici del referto", async () => {
  const { parseInBodyNumber } = await getParser();
  assert.equal(parseInBodyNumber("- 5,7").value, -5.7);
  assert.equal(parseInBodyNumber("4,64").value, 4.64);
  assert.deepEqual(parseInBodyNumber("39,2~47,9").range, { min: 39.2, max: 47.9 });
  assert.equal(parseInBodyNumber("122 %").value, 122);
  assert.equal(parseInBodyNumber("849").value, 849);
});

test("estrae i valori golden dalle ancore e verifica lo storico finale", async () => {
  const { parseInBodyOcrItems, validateInBodyValues } = await getParser();
  const result = parseInBodyOcrItems(items, dimensions, { now: new Date("2026-11-09T12:00:00") });
  const value = Object.fromEntries(Object.entries(result.fields).map(([key, field]) => [key, field.value]));
  assert.deepEqual({
    reportId: value.reportId, heightCm: value.heightCm, age: value.age, sex: value.sex, measuredAtLocal: value.measuredAtLocal,
    totalBodyWaterL: value.totalBodyWaterL, proteinKg: value.proteinKg, mineralsKg: value.mineralsKg,
    bodyFatMassKg: value.bodyFatMassKg, weightKg: value.weightKg, skeletalMuscleKg: value.skeletalMuscleKg,
    bmi: value.bmi, bodyFatPercent: value.bodyFatPercent, score: value.score, targetWeightKg: value.targetWeightKg,
    weightControlKg: value.weightControlKg, fatControlKg: value.fatControlKg, muscleControlKg: value.muscleControlKg,
    basalMetabolicRateKcal: value.basalMetabolicRateKcal, waistHipRatio: value.waistHipRatio,
    visceralFatLevel: value.visceralFatLevel, obesityDegreePercent: value.obesityDegreePercent
  }, {
    reportId: "061224-2", heightCm: 178, age: 23, sex: "male", measuredAtLocal: "2026-11-04T18:37",
    totalBodyWaterL: 49.2, proteinKg: 13.5, mineralsKg: 4.64, bodyFatMassKg: 17.6, weightKg: 84.9,
    skeletalMuscleKg: 38.6, bmi: 26.8, bodyFatPercent: 20.7, score: 82, targetWeightKg: 79.2,
    weightControlKg: -5.7, fatControlKg: -5.7, muscleControlKg: 0,
    basalMetabolicRateKcal: 1823, waistHipRatio: 0.9, visceralFatLevel: 7, obesityDegreePercent: 122
  });
  assert.equal(result.historyCheck.matches, true);
  assert.equal(result.validation.ready, false, "la conferma umana è obbligatoria prima di salvare");
  const confirmed = validateInBodyValues({
    ...value, confirmation: { manuallyConfirmed: true }
  }, { now: new Date("2026-11-09T12:00:00") });
  assert.equal(confirmed.ready, true);
  assert.ok(result.fields.weightKg.bbox.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
});

test("il peso e il muscolo dell’ultima misura storica correggono una lettura diversa della tabella", async () => {
  const { parseInBodyOcrItems } = await getParser();
  const noisy = items.map((item) => item.text === "84,9" && item.poly[0][1] === 255 ? { ...item, text: "94,9" } : item);
  const result = parseInBodyOcrItems(noisy, dimensions, { now: new Date("2026-11-09T12:00:00") });
  assert.equal(result.historyCheck.matches, true);
  assert.equal(result.fields.weightKg.value, 84.9);
  assert.equal(result.fields.skeletalMuscleKg.value, 38.6);
});

test("un valore OCR a bassa confidenza blocca il salvataggio", async () => {
  const { parseInBodyOcrItems } = await getParser();
  const degraded = items.map((item) => item.text === "84,9" && item.poly[0][1] === 842 ? { ...item, score: 0.4 } : item);
  const result = parseInBodyOcrItems(degraded, dimensions, { now: new Date("2026-11-09T12:00:00") });
  assert.equal(result.fields.weightKg.status, "da_verificare");
  assert.equal(result.validation.ready, false);
});

test("la validazione intercetta una cifra decimale spostata", async () => {
  const { parseInBodyOcrItems, validateInBodyValues } = await getParser();
  const parsed = parseInBodyOcrItems(items, dimensions, { now: new Date("2026-11-09T12:00:00") });
  const values = Object.fromEntries(Object.entries(parsed.fields).map(([key, field]) => [key, field.value]));
  const invalid = validateInBodyValues({ ...values, weightKg: 8.49, confirmation: { manuallyConfirmed: true } }, { now: new Date("2026-11-09T12:00:00") });
  assert.equal(invalid.ready, false);
  assert.ok(invalid.issues.some((issue) => issue.fields.includes("weightKg")));
});

test("si può salvare con i soli valori principali dopo conferma manuale", async () => {
  const { validateInBodyValues } = await getParser();
  const core = { measuredAtLocal: "2026-11-04T18:37", weightKg: 84.9, skeletalMuscleKg: 38.6, bodyFatMassKg: 17.6 };
  assert.equal(validateInBodyValues({ ...core, confirmation: { manuallyConfirmed: true } }).ready, true);
  const wrongWeight = validateInBodyValues({ ...core, weightKg: 849, confirmation: { manuallyConfirmed: true } });
  assert.equal(wrongWeight.ready, false);
  assert.ok(wrongWeight.issues.some((issue) => issue.fields.includes("weightKg")));
});

test("rifiuta un file che dichiara immagine ma contiene dati non immagine", async () => {
  const { inspectBiaFile } = await getParser();
  await assert.rejects(() => inspectBiaFile(new Blob(["not an image"], { type: "image/jpeg" })), /Formato non valido/);
});

test("il pannello PT importa solo simboli esportati dal modulo BIA", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const coach = fs.readFileSync(path.join(__dirname, "../www/src/coach.mjs"), "utf8");
  const imported = coach.match(/import\s*\{([^}]+)\}\s*from\s*["']\.\/bia-ocr\.mjs["']/);
  assert.ok(imported, "il pannello deve dichiarare l’import BIA atteso");
  const module = await getParser();
  for (const binding of imported[1].split(",").map((value) => value.trim().split(/\s+as\s+/)[0])) {
    assert.notEqual(module[binding], undefined, `manca l’export BIA ${binding}`);
  }
});
