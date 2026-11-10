const MAX_FILE_BYTES = 15 * 1024 * 1024;
const OCR_SCORE_MIN = 0.82;
const requiredFields = [
  "measuredAtLocal", "weightKg", "skeletalMuscleKg", "bodyFatMassKg"
];

const anchors = {
  reportId: ["id"], heightCm: ["altezza"], age: ["eta"], sex: ["genere"], measuredAtLocal: ["data test ora", "data test"],
  totalBodyWaterL: ["acqua corporea totale"], proteinKg: ["proteine"], mineralsKg: ["minerali"],
  bodyFatMassKg: ["massa grassa del corpo"], weightKg: ["peso"], skeletalMuscleKg: ["muscolo scheletrico"],
  bmi: ["imc", "indice di massa corporea"], bodyFatPercent: ["percentuale di grasso corporeo", "grasso corporeo"],
  score: ["punteggio inbody"], targetWeightKg: ["peso target"], weightControlKg: ["controllo del peso", "controilo del peso"],
  fatControlKg: ["controllo del grasso", "controilo del grasso"], muscleControlKg: ["controllo del muscolo", "controilo del muscolo"],
  basalMetabolicRateKcal: ["tasso metabolico basale"], waistHipRatio: ["relazione cintura fianchi", "rapporto vita fianchi"],
  visceralFatLevel: ["livello grasso viscerale"], obesityDegreePercent: ["grado di obesita"]
};

const norm = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9%.,~+\-/ ]/g, " ").replace(/\s+/g, " ").trim();

export function parseNumberToken(value) {
  const token = String(value ?? "").trim().replace(/\s+/g, "").replace(/,/g, ".");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(token)) return null;
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseInBodyNumber(text) {
  const compact = String(text ?? "").replace(/[−–]/g, "-").replace(/-\s+(?=\d)/g, "-");
  const range = compact.match(/([+-]?\d+(?:[.,]\d+)?)\s*[~–]\s*([+-]?\d+(?:[.,]\d+)?)/);
  const first = compact.match(/[+-]?\s*\d+(?:[.,]\d+)?/);
  if (!first) return { value: null, range: null };
  const value = parseNumberToken(first[0]);
  return {
    value,
    range: range ? { min: parseNumberToken(range[1]), max: parseNumberToken(range[2]) } : null
  };
}

function geometry(item) {
  const polygon = Array.isArray(item?.poly) ? item.poly : Array.isArray(item?.bbox) ? item.bbox : null;
  if (!polygon?.length) return null;
  const points = polygon.map((point) => Array.isArray(point) ? point : [point.x, point.y]).filter((point) => point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))).map(([x, y]) => [Number(x), Number(y)]);
  if (!points.length) return null;
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  return { polygon: points, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), cy: (Math.min(...ys) + Math.max(...ys)) / 2, height: Math.max(...ys) - Math.min(...ys) };
}

function buildItems(ocrItems, dimensions) {
  const width = Number(dimensions?.width || 0), height = Number(dimensions?.height || 0);
  return (ocrItems || []).map((item) => {
    const box = geometry(item);
    if (!box) return null;
    return {
      text: String(item.text || "").trim(), normalized: norm(item.text), score: Number(item.score ?? item.confidence ?? 0),
      ...box, normalizedPolygon: box.polygon.map(([x, y]) => [width ? x / width : 0, height ? y / height : 0])
    };
  }).filter((item) => item?.text).sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
}

function matchAnchor(items, aliases, { after = -Infinity, before = Infinity, exclude = [], minX = -Infinity, maxX = Infinity } = {}) {
  const candidates = items.filter((item) => item.cy >= after && item.cy < before && item.x0 >= minX && item.x0 <= maxX && aliases.some((alias) => item.normalized.includes(alias)) && !exclude.some((alias) => item.normalized.includes(alias)));
  return candidates[0] || null;
}

function numberCandidates(items) {
  return items.map((item) => {
    const parsed = parseInBodyNumber(item.text);
    return parsed.value == null ? null : { ...item, value: parsed.value, range: parsed.range };
  }).filter(Boolean);
}

function nearestSameRow(items, anchor, { minX = anchor?.x1 ?? 0, maxX = Infinity, vertical = 12, ignoreRanges = false } = {}) {
  if (!anchor) return null;
  return numberCandidates(items).filter((item) => item.x0 >= minX && item.x0 <= maxX && Math.abs(item.cy - anchor.cy) <= Math.max(vertical, anchor.height * 0.55) && (!ignoreRanges || !item.range))
    .sort((a, b) => Math.abs(a.cy - anchor.cy) - Math.abs(b.cy - anchor.cy) || a.x0 - b.x0)[0] || null;
}

function nearestBelow(items, anchor, { minX = 0, maxX = Infinity, minDelta = 3, maxDelta = 30, ignoreRanges = true } = {}) {
  if (!anchor) return null;
  return numberCandidates(items).filter((item) => item.x0 >= minX && item.x0 <= maxX && item.cy - anchor.cy >= minDelta && item.cy - anchor.cy <= maxDelta && (!ignoreRanges || !item.range))
    .sort((a, b) => (a.cy - anchor.cy) - (b.cy - anchor.cy) || a.x0 - b.x0)[0] || null;
}

function sameRowText(items, anchor, predicate, { minX = anchor?.x1 ?? 0, vertical = 14 } = {}) {
  if (!anchor) return null;
  return items.filter((item) => item.x0 >= minX && Math.abs(item.cy - anchor.cy) <= Math.max(vertical, anchor.height * 0.55) && predicate(item.normalized))
    .sort((a, b) => a.x0 - b.x0)[0] || null;
}

function nearestBelowText(items, anchor, predicate, { minX = anchor?.x0 ?? 0, maxX = anchor?.x1 ?? Infinity, minDelta = 0, maxDelta = 52 } = {}) {
  if (!anchor) return null;
  return items.filter((item) => item.x1 >= minX && item.x0 <= maxX && item.cy - anchor.cy >= minDelta && item.cy - anchor.cy <= maxDelta && predicate(item.normalized))
    .sort((a, b) => (a.cy - anchor.cy) - (b.cy - anchor.cy))[0] || null;
}

function asField(key, label, item, value, source = "ocr") {
  return {
    value: value ?? null,
    status: item && Number(item.score || 0) >= OCR_SCORE_MIN ? "ok" : "da_verificare",
    confidence: Number(item?.score || 0),
    source,
    bbox: item?.normalizedPolygon?.length ? item.normalizedPolygon : null,
    label,
    reason: item ? (Number(item.score || 0) < OCR_SCORE_MIN ? "Confidenza OCR bassa: controlla il referto." : "") : "Dato non rilevato: inseriscilo o controlla la foto."
  };
}

function textValue(item) {
  if (!item) return null;
  const text = norm(item.text);
  if (/\bmaschio\b/.test(text)) return "male";
  if (/\bfemmina\b/.test(text)) return "female";
  return null;
}

function parseDateTime(text) {
  const match = String(text ?? "").match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[., ]+\s*(\d{1,2})[:.](\d{2}))?/);
  if (!match) return null;
  let year = Number(match[3]);
  if (year < 100) year += year < 50 ? 2000 : 1900;
  const day = Number(match[1]), month = Number(match[2]), hour = Number(match[4] || 0), minute = Number(match[5] || 0);
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || hour > 23 || minute > 59) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function section(items, startAlias, endAlias) {
  const start = matchAnchor(items, [startAlias]);
  if (!start) return { items: [], start: null, end: null };
  const end = matchAnchor(items, [endAlias], { after: start.cy + 1 });
  const filtered = items.filter((item) => item.cy >= start.cy && (!end || item.cy < end.cy));
  return { items: filtered, start, end };
}

function extractHistory(items, dimensions) {
  const start = matchAnchor(items, ["storia della composizione corporea"]);
  if (!start) return { present: false, matches: null, reason: "Tabella storico non rilevata." };
  const historyItems = items.filter((item) => item.cy >= start.cy && item.x0 < dimensions.width * 0.6);
  const values = numberCandidates(historyItems);
  const latestInRow = (alias, preferredCenter) => {
    const rowAnchor = matchAnchor(historyItems, [alias]);
    const center = preferredCenter ?? rowAnchor?.cy;
    if (center == null) return null;
    const verticalTolerance = Math.max(9, Number(rowAnchor?.height || 0) * 0.65);
    const candidates = values.filter((item) => item.x0 >= dimensions.width * 0.12 && item.x0 < dimensions.width * 0.6 && Math.abs(item.cy - center) <= verticalTolerance && !item.range);
    return candidates.sort((a, b) => b.x0 - a.x0)[0] || null;
  };
  const weightRow = matchAnchor(historyItems, ["peso"]);
  const muscleRow = matchAnchor(historyItems, ["massa del"]);
  const fatRow = matchAnchor(historyItems, ["percentuale di"]);
  const lastWeight = latestInRow("peso", weightRow?.cy);
  const lastMuscle = latestInRow("massa del", muscleRow?.cy);
  const lastFat = latestInRow("percentuale di", fatRow?.cy);
  const dateCandidates = historyItems.filter((item) => /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(item.text));
  const dateItem = dateCandidates.sort((a, b) => b.x0 - a.x0)[0] || null;
  const timeCandidates = historyItems.filter((item) => /\b\d{1,2}:\d{2}\b/.test(item.text) && item.x0 > (dateItem?.x0 ?? 0));
  const timeItem = timeCandidates.sort((a, b) => b.x0 - a.x0)[0] || null;
  const dateText = dateItem ? `${dateItem.text} ${timeItem?.text || ""}` : "";
  const measuredAt = parseDateTime(dateText);
  const matches = Boolean(lastWeight && lastMuscle && lastFat && measuredAt);
  return {
    present: true, matches,
    measuredAtLocal: measuredAt,
    weightKg: lastWeight?.value ?? null,
    skeletalMuscleKg: lastMuscle?.value ?? null,
    bodyFatPercent: lastFat?.value ?? null,
    evidence: {
      weight: lastWeight ? { ...lastWeight, normalizedPolygon: lastWeight.normalizedPolygon } : null,
      skeletalMuscle: lastMuscle ? { ...lastMuscle, normalizedPolygon: lastMuscle.normalizedPolygon } : null,
      bodyFatPercent: lastFat ? { ...lastFat, normalizedPolygon: lastFat.normalizedPolygon } : null
    },
    confidence: Math.min(lastWeight?.score || 0, lastMuscle?.score || 0, lastFat?.score || 0, dateItem?.score || 0, timeItem?.score || 0),
    reason: matches ? "" : "Ultima riga dello storico non letta con certezza."
  };
}

export function validateInBodyValues(input, { now = new Date() } = {}) {
  const values = Object.fromEntries(Object.entries(input || {}).map(([key, value]) => [key, value && typeof value === "object" && "value" in value ? value.value : value]));
  const issues = [];
  const mark = (keys, message) => issues.push({ fields: keys, message });
  const ranges = {
    weightKg: [30, 250, "Peso"], heightCm: [120, 230, "Altezza"], age: [5, 100, "Età"],
    bodyFatPercent: [2, 60, "Percentuale di grasso"], bodyFatMassKg: [0.1, 100, "Massa grassa"],
    skeletalMuscleKg: [1, 150, "Massa muscolare scheletrica"], bmi: [10, 60, "IMC"], score: [0, 100, "Punteggio InBody"],
    visceralFatLevel: [1, 20, "Grasso viscerale"], basalMetabolicRateKcal: [500, 6000, "Metabolismo basale"],
    waistHipRatio: [0.3, 2, "Rapporto vita/fianchi"], targetWeightKg: [20, 250, "Peso obiettivo"],
    totalBodyWaterL: [1, 200, "Acqua corporea"], proteinKg: [0.1, 100, "Proteine"], mineralsKg: [0.1, 50, "Minerali"],
    obesityDegreePercent: [30, 300, "Grado di obesità"], weightControlKg: [-200, 200, "Controllo peso"],
    fatControlKg: [-200, 200, "Controllo grasso"], muscleControlKg: [-200, 200, "Controllo muscolo"]
  };
  for (const [key, [min, max, label]] of Object.entries(ranges)) {
    const value = values[key];
    if (value == null || value === "") {
      if (requiredFields.includes(key)) mark([key], `${label}: dato obbligatorio non rilevato.`);
      continue;
    }
    if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) mark([key], `${label}: valore fuori dall’intervallo plausibile.`);
  }
  if (values.sex != null && values.sex !== "male" && values.sex !== "female") mark(["sex"], "Sesso non riconosciuto: controlla il referto.");
  const timestamp = values.measuredAtLocal;
  const measured = timestamp ? new Date(timestamp) : null;
  if (!measured || !Number.isFinite(measured.getTime())) mark(["measuredAtLocal"], "Data e ora non valide.");
  else if (measured.getTime() > now.getTime() + 5 * 60 * 1000) mark(["measuredAtLocal"], "La data del referto è futura.");

  const near = (a, b, tolerance) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
  if ([values.weightKg, values.totalBodyWaterL, values.proteinKg, values.mineralsKg, values.bodyFatMassKg].every((v) => Number.isFinite(Number(v))) && !near(values.weightKg, Number(values.totalBodyWaterL) + Number(values.proteinKg) + Number(values.mineralsKg) + Number(values.bodyFatMassKg), 0.3)) {
    mark(["weightKg", "totalBodyWaterL", "proteinKg", "mineralsKg", "bodyFatMassKg"], "Il peso non coincide con la somma dei componenti corporei (±0,3 kg). Verifica i valori sul referto.");
  }
  if (Number.isFinite(Number(values.weightKg)) && Number.isFinite(Number(values.heightCm)) && Number.isFinite(Number(values.bmi))) {
    const bmi = Number(values.weightKg) / ((Number(values.heightCm) / 100) ** 2);
    if (!near(values.bmi, bmi, 0.15)) mark(["weightKg", "heightCm", "bmi"], "IMC non coerente con peso e altezza (±0,15).");
  }
  if (Number.isFinite(Number(values.bodyFatMassKg)) && Number.isFinite(Number(values.weightKg)) && Number.isFinite(Number(values.bodyFatPercent))) {
    if (!near(values.bodyFatPercent, Number(values.bodyFatMassKg) / Number(values.weightKg) * 100, 0.3)) mark(["weightKg", "bodyFatMassKg", "bodyFatPercent"], "Grasso corporeo non coerente con massa grassa e peso (±0,3%).");
  }
  if (Number.isFinite(Number(values.bodyFatMassKg)) && Number.isFinite(Number(values.weightKg)) && Number.isFinite(Number(values.skeletalMuscleKg))) {
    const fatFreeMassKg = Number(values.weightKg) - Number(values.bodyFatMassKg);
    if (fatFreeMassKg <= 0 || Number(values.skeletalMuscleKg) > fatFreeMassKg + 0.2) mark(["weightKg", "bodyFatMassKg", "skeletalMuscleKg"], "La massa muscolare deve rientrare nella massa magra: controlla peso e massa grassa.");
  }
  if (Number.isFinite(Number(values.targetWeightKg)) && Number.isFinite(Number(values.weightControlKg)) && Number.isFinite(Number(values.weightKg)) && !near(values.targetWeightKg, Number(values.weightKg) + Number(values.weightControlKg), 0.2)) {
    mark(["weightKg", "targetWeightKg", "weightControlKg"], "Peso obiettivo non coerente con il controllo peso (±0,2 kg).");
  }
  if ([values.weightControlKg, values.fatControlKg, values.muscleControlKg].every((v) => Number.isFinite(Number(v))) && !near(values.weightControlKg, Number(values.fatControlKg) + Number(values.muscleControlKg), 0.2)) {
    mark(["weightControlKg", "fatControlKg", "muscleControlKg"], "Controllo peso non coerente con controllo grasso e muscolo (±0,2 kg).");
  }
  const confirmation = values.confirmation;
  if (confirmation?.manuallyConfirmed !== true) mark(["weightKg", "skeletalMuscleKg", "bodyFatMassKg"], "Conferma di aver verificato i tre valori direttamente sul referto.");
  return { issues, ready: issues.length === 0, requiredFields };
}

export function parseInBodyOcrItems(ocrItems, dimensions, { now = new Date() } = {}) {
  const items = buildItems(ocrItems, dimensions);
  const composition = section(items, "analisi della composizione corporea", "analisi muscolo");
  const muscleFat = section(items, "analisi muscolo", "analisi dell obesita");
  const obesity = section(items, "analisi dell obesita", "analisi massa magra segmentale");
  const search = section(items, "parametri di ricerca", "interpretazione dei risultati");
  const all = (start, end) => items.filter((item) => item.cy >= start && item.cy < end);
  const top = items[0]?.cy ?? 0;
  const compositionTop = composition.start?.cy ?? top;
  const headerEnd = composition.start?.cy ?? Infinity;
  const fieldItems = {};
  const setRight = (key, alias, pool, opts = {}) => {
    const anchor = matchAnchor(pool, anchors[key] || [alias], opts.anchor || {});
    const found = nearestSameRow(pool, anchor, opts);
    fieldItems[key] = found || anchor;
    return found?.value ?? null;
  };
  const header = all(top, headerEnd);
  const idAnchor = matchAnchor(header, anchors.reportId, { exclude: ["analisi"] });
  const idItem = nearestBelowText(header, idAnchor, (text) => /^[a-z0-9-]{4,20}$/.test(text) && !text.includes("id"), { maxX: (idAnchor?.x1 ?? 0) + dimensions.width * 0.05 });
  fieldItems.reportId = idItem || idAnchor;
  const heightAnchor = matchAnchor(header, anchors.heightCm);
  const ageAnchor = matchAnchor(header, anchors.age);
  const sexAnchor = matchAnchor(header, anchors.sex);
  const dateAnchor = matchAnchor(header, anchors.measuredAtLocal);
  const device = matchAnchor(items, ["inbody120"]);
  const fields = {};
  const add = (key, label, value, item) => { fields[key] = asField(key, label, item, value); };
  const reportId = idItem?.text?.replace(/\s+/g, "") || null;
  add("reportId", "ID referto", reportId, idItem);
  const headerBelow = (anchor, predicate) => nearestBelowText(header, anchor, predicate, { minX: (anchor?.x0 ?? 0) - 6, maxX: (anchor?.x1 ?? 0) + 8, maxDelta: 60 });
  const h = headerBelow(heightAnchor, (text) => /\d/.test(text)); add("heightCm", "Altezza", h ? parseInBodyNumber(h.text).value : null, h);
  const age = headerBelow(ageAnchor, (text) => /^\d{1,3}$/.test(text)); add("age", "Età", age ? Math.round(parseInBodyNumber(age.text).value) : null, age);
  const sex = headerBelow(sexAnchor, (text) => /\b(maschio|femmina)\b/.test(text)); add("sex", "Sesso", textValue(sex), sex);
  const date = headerBelow(dateAnchor, (text) => parseDateTime(text) !== null); add("measuredAtLocal", "Data e ora", parseDateTime(date?.text), date);
  add("device", "Dispositivo", "InBody120", device);

  const compField = (key, label) => setRight(key, label, composition.items, { vertical: 12, maxX: dimensions.width * 0.64, ignoreRanges: true, anchor: { minX: 0, maxX: dimensions.width * 0.45, exclude: ["target", "controllo"] } });
  compField("totalBodyWaterL", "Acqua corporea totale");
  compField("proteinKg", "Proteine");
  compField("mineralsKg", "Minerali");
  compField("bodyFatMassKg", "Massa grassa del corpo");
  compField("weightKg", "Peso");
  for (const [key, label] of [["totalBodyWaterL", "Acqua corporea totale"], ["proteinKg", "Proteine"], ["mineralsKg", "Minerali"], ["bodyFatMassKg", "Massa grassa"], ["weightKg", "Peso"]]) {
    const item = fieldItems[key]; add(key, label, item?.value ?? null, item);
  }

  const findBelowAnchor = (key, label, pool, aliases, opts = {}) => {
    const anchor = matchAnchor(pool, aliases);
    const found = nearestBelow(pool, anchor, opts);
    add(key, label, found?.value ?? null, found || anchor);
  };
  findBelowAnchor("skeletalMuscleKg", "Muscolo scheletrico", muscleFat.items, ["muscolo scheletrico"], { minX: dimensions.width * 0.25, maxX: dimensions.width * 0.64, minDelta: 2, maxDelta: 22 });
  findBelowAnchor("bmi", "IMC", obesity.items, ["imc"], { minX: dimensions.width * 0.25, minDelta: 3, maxDelta: 28 });
  findBelowAnchor("bodyFatPercent", "Percentuale di grasso", obesity.items, ["percentuale di"], { minX: dimensions.width * 0.25, minDelta: 4, maxDelta: 30 });

  const scoreAnchor = matchAnchor(items, anchors.score);
  const scoreItem = scoreAnchor ? numberCandidates(items).filter((item) => item.x0 > dimensions.width * 0.67 && item.cy > scoreAnchor.cy + 8 && item.cy < scoreAnchor.cy + 64 && !item.range).sort((a, b) => a.cy - b.cy)[0] : null;
  add("score", "Punteggio InBody", scoreItem?.value ?? null, scoreItem || scoreAnchor);

  const controlHeading = matchAnchor(items, ["controllo del peso", "controilo del peso"], { maxX: dimensions.width * 0.8 });
  const controlBlock = items.filter((item) => item.cy > (controlHeading?.cy ?? -Infinity) + 12 && item.cy < (search.start?.cy ?? Infinity) && item.x0 > dimensions.width * 0.55);
  const searchFields = [
    ["targetWeightKg", "Peso obiettivo"], ["weightControlKg", "Controllo peso"], ["fatControlKg", "Controllo grasso"],
    ["muscleControlKg", "Controllo muscolo"], ["basalMetabolicRateKcal", "Metabolismo basale"],
    ["waistHipRatio", "Rapporto vita/fianchi"], ["visceralFatLevel", "Grasso viscerale"], ["obesityDegreePercent", "Grado di obesità"]
  ];
  for (const [key, label] of searchFields) {
    const pool = key === "targetWeightKg" || key.endsWith("ControlKg") ? controlBlock : search.items;
    const found = setRight(key, label, pool, { vertical: 16, ignoreRanges: true });
    add(key, label, found, fieldItems[key]);
  }

  fields.bmi.value = fields.bmi.value == null ? null : Number(Number(fields.bmi.value).toFixed(1));
  fields.bodyFatPercent.value = fields.bodyFatPercent.value == null ? null : Number(Number(fields.bodyFatPercent.value).toFixed(1));
  fields.skeletalMuscleKg.value = fields.skeletalMuscleKg.value == null ? null : Number(Number(fields.skeletalMuscleKg.value).toFixed(2));
  for (const key of ["weightKg", "targetWeightKg", "weightControlKg", "fatControlKg", "muscleControlKg", "totalBodyWaterL", "proteinKg"]) if (fields[key]?.value != null) fields[key].value = Number(Number(fields[key].value).toFixed(2));
  if (fields.heightCm?.value != null) fields.heightCm.value = Number(Number(fields.heightCm.value).toFixed(1));
  if (fields.age?.value != null) fields.age.value = Math.round(fields.age.value);
  if (fields.visceralFatLevel?.value != null) fields.visceralFatLevel.value = Math.round(fields.visceralFatLevel.value);
  if (fields.score?.value != null) fields.score.value = Math.round(fields.score.value);
  if (fields.basalMetabolicRateKcal?.value != null) fields.basalMetabolicRateKcal.value = Math.round(fields.basalMetabolicRateKcal.value);
  if (fields.obesityDegreePercent?.value != null) fields.obesityDegreePercent.value = Math.round(fields.obesityDegreePercent.value);
  if (fields.waistHipRatio?.value != null) fields.waistHipRatio.value = Number(Number(fields.waistHipRatio.value).toFixed(2));
  const historyCheck = extractHistory(items, dimensions);
  if (historyCheck.matches) {
    for (const [key, historyKey, label] of [
      ["weightKg", "weight", "Peso"],
      ["skeletalMuscleKg", "skeletalMuscle", "Massa muscolo scheletrico"]
    ]) {
      const evidence = historyCheck.evidence?.[historyKey];
      if (evidence) fields[key] = asField(key, label, evidence, historyCheck[key]);
    }
  }
  const validation = validateInBodyValues({ ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])), confirmation: { manuallyConfirmed: false } }, { now });
  for (const issue of validation.issues) for (const key of issue.fields) if (fields[key]) { fields[key].status = "da_verificare"; fields[key].reason = issue.message; }
  for (const key of requiredFields) {
    const field = fields[key];
    if (field && field.status !== "ok" && !validation.issues.some((issue) => issue.fields.includes(key))) {
      validation.issues.push({ fields: [key], message: field.reason || `${field.label}: verifica il valore sul referto.` });
    }
  }
  validation.ready = validation.issues.length === 0 && requiredFields.every((key) => fields[key]?.status === "ok");
  return {
    fields, historyCheck, validation,
    documentDimensions: { width: dimensions.width, height: dimensions.height },
    ocrItems: items.map((item) => ({ text: item.text, confidence: item.score, bbox: item.normalizedPolygon }))
  };
}

export async function inspectBiaFile(file) {
  if (!(file instanceof Blob)) throw new Error("Seleziona un file referto valido.");
  if (file.size <= 0 || file.size > MAX_FILE_BYTES) throw new Error("Il referto deve pesare meno di 15 MB.");
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const starts = (...signature) => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (from, length) => String.fromCharCode(...bytes.slice(from, from + length));
  let type = null;
  if (starts(0xff, 0xd8, 0xff)) type = "image/jpeg";
  else if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) type = "image/png";
  else if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") type = "image/webp";
  else if (ascii(0, 5) === "%PDF-") type = "application/pdf";
  else if (ascii(4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1|avif)$/i.test(ascii(8, 4))) type = /avif/i.test(ascii(8, 4)) ? "image/avif" : "image/heic";
  if (!type || !["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"].includes(type)) throw new Error("Formato non valido. Usa JPG, PNG, WebP, HEIC o PDF.");
  const declared = String(file.type || "").toLowerCase();
  if (declared && declared !== type && !(type === "image/heic" && declared === "image/heif")) throw new Error("Il contenuto del file non corrisponde al formato dichiarato.");
  return { type, size: file.size };
}

let runtimePromise;
async function getRuntime() {
  if (!runtimePromise) runtimePromise = import("../vendor/bia-runtime/bia-runtime.js?v=20261109-workerfix").then((runtime) => {
    if (typeof runtime.PaddleOCR?.create !== "function") throw new Error("Bundle OCR incompleto: manca l’esportazione PaddleOCR. Ricompila e ripubblica il sito.");
    return runtime;
  }).catch((error) => {
    runtimePromise = null;
    if (/Bundle OCR incompleto/.test(error?.message || "")) throw error;
    throw new Error("Motore BIA non caricato. Ricompila con npm run build:bia-ocr e ripubblica il sito.");
  });
  return runtimePromise;
}

async function fileToImageBlob(file, type, runtime) {
  if (type !== "image/heic" && type !== "image/heif") return file;
  const converted = await runtime.heic2any({ blob: file, toType: "image/jpeg", quality: 0.96 });
  return Array.isArray(converted) ? converted[0] : converted;
}

async function imageBitmap(file) {
  if (typeof createImageBitmap === "function") return createImageBitmap(file, { imageOrientation: "from-image" });
  const url = URL.createObjectURL(file);
  const image = new Image(); image.src = url;
  try { await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("Il referto non è leggibile come immagine.")); }); return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) }; }
  catch (error) { URL.revokeObjectURL(url); throw error; }
}

export async function normalizeBiaImage(file) {
  const bitmap = await imageBitmap(file);
  try {
    const source = bitmap.source || bitmap;
    const scale = Math.min(1, 2200 / bitmap.width, 3200 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(source, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    const threshold = (axis, index) => {
      let bright = 0, samples = 0;
      const len = axis === "y" ? width : height, step = Math.max(1, Math.floor(len / 600));
      for (let pos = 0; pos < len; pos += step) {
        const offset = axis === "y" ? (index * width + pos) * 4 : (pos * width + index) * 4;
        const luma = (data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
        if (luma > 168) bright++; samples++;
      }
      return samples ? bright / samples : 0;
    };
    const topRows = []; for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 800))) if (threshold("y", y) > 0.18) topRows.push(y);
    let top = topRows.length ? topRows[0] : 0, bottom = topRows.length ? topRows.at(-1) : height - 1;
    const verticalMargin = Math.round((bottom - top + 1) * 0.008); top = Math.max(0, top - verticalMargin); bottom = Math.min(height - 1, bottom + verticalMargin);
    const columns = []; for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 600))) if (threshold("x", x) > 0.18) columns.push(x);
    let left = columns.length ? columns[0] : 0, right = columns.length ? columns.at(-1) : width - 1;
    const horizontalMargin = Math.round((right - left + 1) * 0.008); left = Math.max(0, left - horizontalMargin); right = Math.min(width - 1, right + horizontalMargin);
    const cropWidth = right - left + 1, cropHeight = bottom - top + 1;
    const outWidth = Math.min(2200, Math.max(1600, cropWidth));
    const outHeight = Math.round(cropHeight * outWidth / cropWidth);
    const normalized = document.createElement("canvas"); normalized.width = outWidth; normalized.height = outHeight;
    const outContext = normalized.getContext("2d"); outContext.imageSmoothingEnabled = true; outContext.imageSmoothingQuality = "high"; outContext.filter = "grayscale(1) contrast(1.12)";
    outContext.drawImage(canvas, left, top, cropWidth, cropHeight, 0, 0, outWidth, outHeight);
    return { canvas: normalized, width: outWidth, height: outHeight, crop: { left, top, width: cropWidth, height: cropHeight, sourceWidth: width, sourceHeight: height } };
  } finally { bitmap.close?.(); }
}

function pdfTextItems(page, content, viewport) {
  const result = [];
  for (const item of content.items || []) {
    if (!item.str?.trim() || !Array.isArray(item.transform)) continue;
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const width = Math.max(1, item.width * viewport.scale), height = Math.max(1, item.height * viewport.scale);
    result.push({ text: item.str, score: 1, poly: [[x, y - height], [x + width, y - height], [x + width, y], [x, y]] });
  }
  return result;
}

async function runOcr(canvas, onProgress) {
  const runtime = await getRuntime();
  const { PaddleOCR } = runtime;
  const report = await PaddleOCR.create({
    lang: "it", ocrVersion: "PP-OCRv6", worker: true,
    ortOptions: { backend: "wasm", wasmPaths: "/vendor/bia-runtime/ort/", numThreads: 1, simd: true }
  });
  try {
    onProgress({ status: "Analisi locale del referto…", progress: 0.35 });
    const result = (await report.predict(canvas))[0];
    onProgress({ status: "Controllo delle ancore e dei valori…", progress: 0.88 });
    return { items: result.items, dimensions: result.image, runtime: result.runtime };
  } finally { await report.dispose(); }
}

export async function recognizeInBodyPhoto(file, onProgress = () => {}) {
  const format = await inspectBiaFile(file);
  onProgress({ status: "Preparo il referto sul dispositivo…", progress: 0.05 });
  const runtime = await getRuntime();
  let items, dimensions, preview;
  if (format.type === "application/pdf") {
    const pdfjs = runtime.pdfjs;
    const pdfDocument = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    if (!pdfDocument.numPages) throw new Error("Il PDF non contiene pagine.");
    const page = await pdfDocument.getPage(1), viewport = page.getViewport({ scale: 1.7 });
    const text = await page.getTextContent();
    if ((text.items || []).filter((item) => item.str?.trim()).length >= 12) {
      items = pdfTextItems(page, text, viewport); dimensions = { width: viewport.width, height: viewport.height };
      const canvas = globalThis.document.createElement("canvas"); canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise; preview = canvas;
    } else {
      const canvas = globalThis.document.createElement("canvas"); canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
      const ocr = await runOcr(canvas, onProgress); items = ocr.items; dimensions = ocr.dimensions; preview = canvas;
    }
    await pdfDocument.destroy();
  } else {
    const ocrFile = await fileToImageBlob(file, format.type, runtime);
    const normalized = await normalizeBiaImage(ocrFile); preview = normalized.canvas;
    const ocr = await runOcr(normalized.canvas, onProgress); items = ocr.items; dimensions = ocr.dimensions;
  }
  const recognized = buildItems(items, dimensions);
  if (!recognized.some((item) => item.normalized.includes("inbody")) || !recognized.some((item) => item.normalized.includes("analisi della composizione corporea"))) {
    throw new Error("Formato non riconosciuto: serve un referto InBody con intestazione leggibile.");
  }
  const result = parseInBodyOcrItems(items, dimensions);
  onProgress({ status: result.validation.ready ? "Referto letto: controlla i dati prima del salvataggio." : "Lettura completata: alcuni dati richiedono verifica manuale.", progress: 1 });
  return { ...result, preview, fileType: format.type };
}

export { requiredFields as requiredBiaFields };
