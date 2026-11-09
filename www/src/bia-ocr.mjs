const OCR_SCRIPT = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const OCR_WORKER = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js";
const OCR_CORE = "https://cdn.jsdelivr.net/npm/tesseract.js-core@5";
const OCR_LANG = "https://tessdata.projectnaptha.com/4.0.0";
let scriptLoad;

function loadOcrEngine() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!scriptLoad) scriptLoad = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = OCR_SCRIPT; script.async = true; script.crossOrigin = "anonymous";
    script.onload = () => window.Tesseract ? resolve(window.Tesseract) : (scriptLoad = null, reject(new Error("Lettore BIA non disponibile.")));
    script.onerror = () => { scriptLoad = null; script.remove(); reject(new Error("Impossibile caricare il lettore OCR. Controlla la connessione e riprova.")); };
    document.head.append(script);
  });
  return scriptLoad;
}

async function imageSource(file) {
  if (typeof createImageBitmap === "function") return createImageBitmap(file, { imageOrientation: "from-image" });
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("La foto non è leggibile.")); });
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

async function prepareImage(file) {
  const source = await imageSource(file);
  try {
    if (!source.width || !source.height) throw new Error("La foto non è leggibile.");
    const scale = Math.min(1, 2200 / source.width, 3000 / source.height);
    const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
    const original = document.createElement("canvas"); original.width = width; original.height = height;
    const originalContext = original.getContext("2d", { willReadFrequently: true });
    originalContext.drawImage(source.image || source, 0, 0, width, height);

    // Ritaglia gli spazi scuri attorno al foglio (tipici di una foto o schermata del referto).
    const pixels = originalContext.getImageData(0, 0, width, height).data;
    let top = 0, bottom = height - 1;
    const brightFraction = (y) => { let bright = 0; const step = Math.max(1, Math.floor(width / 500)); for (let x = 0; x < width; x += step) { const i = (y * width + x) * 4; if ((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 > 145) bright++; } return bright / Math.ceil(width / step); };
    while (top < height * 0.35 && brightFraction(top) < 0.12) top++;
    while (bottom > height * 0.65 && brightFraction(bottom) < 0.12) bottom--;
    const margin = Math.round((bottom - top + 1) * 0.012); top = Math.max(0, top - margin); bottom = Math.min(height - 1, bottom + margin);

    const cropHeight = bottom - top + 1;
    const output = document.createElement("canvas"); output.width = Math.min(2200, Math.max(width, 1600)); output.height = Math.round(cropHeight * output.width / width);
    const context = output.getContext("2d"); context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high"; context.filter = "grayscale(1) contrast(1.2)";
    context.drawImage(original, 0, top, width, cropHeight, 0, 0, output.width, output.height);
    return output;
  } finally { source.close?.(); }
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[·•]/g, " ").replace(/\s+/g, " ").trim();
}
function numbersOutsideParentheses(value) {
  const text = String(value || ""), results = [];
  for (const match of text.matchAll(/[-+]?\d+(?:[.,]\d+)?/g)) {
    let depth = 0; for (const char of text.slice(0, match.index)) { if (char === "(") depth++; else if (char === ")") depth = Math.max(0, depth - 1); }
    if (depth === 0) {
      const raw = match[0];
      const value = /^\d{1,3}[.,]\d{3}$/.test(raw) ? Number(raw.replace(/[.,]/g, "")) : Number(raw.replace(",", "."));
      if (Number.isFinite(value)) results.push(value);
    }
  }
  return results;
}
function findValue(lines, aliases, { exclude = [], last = false, before = null } = {}) {
  const limit = before ?? lines.length;
  for (let index = 0; index < limit; index++) {
    const line = normalized(lines[index]);
    const alias = aliases.find((value) => line.includes(value));
    if (!alias || exclude.some((value) => line.includes(value))) continue;
    const rawLine = lines[index]; const position = normalized(rawLine).indexOf(alias);
    const sameLine = numbersOutsideParentheses(rawLine.slice(Math.max(0, position + alias.length)));
    if (sameLine.length) return last ? sameLine.at(-1) : sameLine[0];
    for (let next = index + 1; next <= Math.min(limit - 1, index + 2); next++) {
      const nextLine = normalized(lines[next]);
      if (/^(analisi|storia|impedenza|interpretazione|codice qr)/.test(nextLine)) break;
      const values = numbersOutsideParentheses(lines[next]);
      if (values.length) return last ? values.at(-1) : values[0];
    }
  }
  return null;
}
function localDateTime(year, month, day, time = "00:00") {
  const [hour, minute] = time.split(":").map(Number);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
function extractDate(text) {
  const match = String(text || "").match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\s*[,·-]?\s*(\d{1,2}:\d{2}))?/);
  if (!match) return null;
  let year = Number(match[3]); if (year < 100) year += year < 50 ? 2000 : 1900;
  return localDateTime(year, Number(match[2]), Number(match[1]), match[4] || "00:00");
}
const rounded = (value, digits = 2) => value == null ? null : Number(value.toFixed(digits));

export function parseInBodyText(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const normalizedLines = lines.map(normalized);
  const compositionEnd = normalizedLines.findIndex((line) => line.includes("analisi muscolo"));
  const bodyCompositionLimit = compositionEnd < 0 ? lines.length : compositionEnd;
  const weightKg = findValue(lines, ["peso"], { exclude: ["peso target", "controllo del peso", "analisi muscolo", "storia"] , before: bodyCompositionLimit });
  const heightCm = findValue(lines, ["altezza"]);
  const age = findValue(lines, ["eta"]);
  const bodyFatPercent = findValue(lines, ["percentuale di grasso corporeo", "grasso corporeo (%)", "pgc"], { last: true });
  const bodyFatMassKg = findValue(lines, ["massa grassa del corpo", "massa grassa corporea"], { exclude: ["segmentale"] });
  const skeletalMuscleKg = findValue(lines, ["massa del muscolo scheletrico", "massa muscolo scheletrico"], { last: true });
  const totalBodyWaterL = findValue(lines, ["acqua corporea totale"]);
  const proteinKg = findValue(lines, ["proteine"]);
  const mineralsKg = findValue(lines, ["minerali"]);
  const bmi = findValue(lines, ["imc", "indice di massa corporea", "bmi"], { last: true });
  const visceralFatLevel = findValue(lines, ["livello grasso viscerale", "grasso viscerale"]);
  const basalMetabolicRateKcal = findValue(lines, ["tasso metabolico basale", "metabolismo basale"]);
  const waistHipRatio = findValue(lines, ["relazione cintura fianchi", "rapporto vita fianchi", "vita/fianchi"] , { last: true });
  const score = findValue(lines, ["punteggio inbody"]);
  const targetWeightKg = findValue(lines, ["peso target"]);
  const weightControlKg = findValue(lines, ["controllo del peso"]);
  const fatControlKg = findValue(lines, ["controllo del grasso"]);
  const muscleControlKg = findValue(lines, ["controllo del muscolo"]);
  const normalizedText = normalized(text);
  const sex = /\bmaschio\b/.test(normalizedText) ? "male" : /\bfemmina\b/.test(normalizedText) ? "female" : null;
  const fatMass = bodyFatMassKg ?? (weightKg != null && bodyFatPercent != null ? weightKg * bodyFatPercent / 100 : null);
  const parsedHeight = heightCm != null && heightCm < 3 ? heightCm * 100 : heightCm;
  return {
    measuredAtLocal: extractDate(text), age: age == null ? null : Math.round(age), sex,
    heightCm: rounded(parsedHeight, 1), weightKg: rounded(weightKg, 1),
    bmi: bmi == null && parsedHeight && weightKg ? rounded(weightKg / ((parsedHeight / 100) ** 2), 1) : rounded(bmi, 1),
    obesityDegreePercent: parsedHeight && weightKg ? Math.round((weightKg / (22 * ((parsedHeight / 100) ** 2))) * 100) : null,
    bodyFatPercent: rounded(bodyFatPercent, 1), bodyFatMassKg: rounded(fatMass, 2),
    fatFreeMassKg: fatMass == null || weightKg == null ? null : rounded(weightKg - fatMass, 2),
    skeletalMuscleKg: rounded(skeletalMuscleKg, 1), totalBodyWaterL: rounded(totalBodyWaterL, 1),
    proteinKg: rounded(proteinKg, 1), mineralsKg: rounded(mineralsKg, 2), visceralFatLevel: visceralFatLevel == null ? null : Math.round(visceralFatLevel),
    basalMetabolicRateKcal: basalMetabolicRateKcal == null ? null : Math.round(basalMetabolicRateKcal),
    waistHipRatio: rounded(waistHipRatio, 2), score: score == null ? null : Math.round(score),
    targetWeightKg: rounded(targetWeightKg, 1), weightControlKg: rounded(weightControlKg, 1),
    fatControlKg: rounded(fatControlKg, 1), muscleControlKg: rounded(muscleControlKg, 1), rawText: String(text || "").slice(0, 16000)
  };
}

export async function recognizeInBodyPhoto(file, onProgress = () => {}) {
  if (!(file instanceof Blob) || !file.type.startsWith("image/")) throw new Error("Seleziona una foto in formato JPG o PNG.");
  if (file.size > 15 * 1024 * 1024) throw new Error("La foto supera 15 MB. Riducila o scatta una nuova foto.");
  const engine = await loadOcrEngine(); onProgress({ status: "Preparo la foto…", progress: 0.04 });
  const image = await prepareImage(file);
  let worker;
  try {
    worker = await engine.createWorker("ita", 1, {
      workerPath: OCR_WORKER, corePath: OCR_CORE, langPath: OCR_LANG,
      logger: (event) => onProgress({ status: event.status || "Leggo il referto…", progress: Number(event.progress || 0) })
    });
    const { data } = await worker.recognize(image);
    return { ...parseInBodyText(data.text), confidence: Number(data.confidence || 0) };
  } finally { await worker?.terminate(); }
}
