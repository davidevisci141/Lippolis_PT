const test = require("node:test");
const assert = require("node:assert/strict");

test("estrae i valori principali da un referto InBody in italiano", async () => {
  const { parseInBodyText } = await import("../www/src/bia-ocr.mjs");
  const report = `Altezza 178cm Eta 23 Genere Maschio Data Test Ora 04.11.2026 18:37
Acqua Corporea Totale (L) 49,2 (39,2-47,9)
Proteine (kg) 13,5 (10,5-12,8)
Minerali (kg) 4,64 (3,63-4,43)
Massa Grassa del Corpo (kg) 17,6 (8,4-16,7)
Peso (kg) 84,9 (59,2-80,2)
Analisi Muscolo - Grasso
Massa del Muscolo Scheletrico (kg) 38,6
IMC Indice di Massa Corporea 26,8
Percentuale di Grasso Corporeo (%) 20,7
Tasso Metabolico Basale 1823
Relazione Cintura Fianchi 0,90
Livello Grasso Viscerale 7
Punteggio InBody 82/100
Peso Target 79,2 kg
Controllo del Peso -5,7 kg
Controllo del Grasso -5,7 kg
Controllo del Muscolo 0,0 kg`;

  const values = parseInBodyText(report);
  assert.equal(values.measuredAtLocal, "2026-11-04T18:37");
  assert.equal(values.heightCm, 178);
  assert.equal(values.weightKg, 84.9);
  assert.equal(values.bmi, 26.8);
  assert.equal(values.bodyFatPercent, 20.7);
  assert.equal(values.bodyFatMassKg, 17.6);
  assert.equal(values.fatFreeMassKg, 67.3);
  assert.equal(values.skeletalMuscleKg, 38.6);
  assert.equal(values.totalBodyWaterL, 49.2);
  assert.equal(values.proteinKg, 13.5);
  assert.equal(values.mineralsKg, 4.64);
  assert.equal(values.visceralFatLevel, 7);
  assert.equal(values.basalMetabolicRateKcal, 1823);
  assert.equal(values.waistHipRatio, 0.9);
  assert.equal(values.score, 82);
});
