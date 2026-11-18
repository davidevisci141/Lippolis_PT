// Foto dei progressi: nomi dei file e raggruppamento per caricamento (senza dipendenze, testabile).
// Nuovo formato: <atleta>/<lotto>-athlete-progress-<posa>.jpg (stesso lotto = stesso caricamento).
// Formato precedente: <atleta>/<uuid>-athlete-progress.jpg (una foto per caricamento, senza posa).
export const POSES = ["fronte", "lato", "retro"];
export const POSE_LABELS = { fronte: "Fronte", lato: "Lato", retro: "Retro" };
const uuid = "[\\da-f]{8}(?:-[\\da-f]{4}){3}-[\\da-f]{12}";
export const PROGRESS_FILE_PATTERN = new RegExp(`^(${uuid})-athlete-progress(?:-(${POSES.join("|")}))?\\.jpg$`, "i");

export function progressFileName(batch, pose) {
  if (!POSES.includes(pose)) throw new Error("Posa non valida");
  return `${batch}-athlete-progress-${pose}.jpg`;
}

export function parseProgressFileName(name) {
  const match = PROGRESS_FILE_PATTERN.exec(String(name || ""));
  if (!match) return null;
  const pose = match[2] ? match[2].toLowerCase() : null;
  return { batch: pose ? match[1].toLowerCase() : null, pose };
}

const dayKey = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return "senza-data";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Un gruppo per caricamento (lotto); le foto vecchie senza lotto si raggruppano per giorno.
// Ogni gruppo: { key, date, photos } con le pose in ordine Fronte, Lato, Retro e poi le foto senza posa.
export function groupProgressPhotos(photos) {
  const groups = new Map();
  for (const photo of photos || []) {
    const key = photo.batch ? `lotto:${photo.batch}` : `giorno:${dayKey(photo.date)}`;
    if (!groups.has(key)) groups.set(key, { key, date: photo.date, photos: [] });
    const group = groups.get(key);
    group.photos.push(photo);
    if (photo.date > group.date) group.date = photo.date;
  }
  const order = (photo) => photo.pose ? POSES.indexOf(photo.pose) : POSES.length;
  for (const group of groups.values()) group.photos.sort((a, b) => order(a) - order(b) || a.date - b.date);
  return [...groups.values()].sort((a, b) => b.date - a.date);
}
