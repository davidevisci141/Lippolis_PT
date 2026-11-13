import { supabase } from "./supabase.mjs";

export const PHOTO_BUCKET = "coach-client-files";
const suffix = "-athlete-progress.jpg";
const filePattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}-athlete-progress\.jpg$/i;
const maxFileSize = 15 * 1024 * 1024;
const pageSize = 100;

export async function listProgressPhotos(athleteId) {
  const photos = new Map();
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).list(athleteId, {
      limit: pageSize, offset, sortBy: { column: "name", order: "asc" }
    });
    if (error) throw error;
    for (const file of data) {
      if (filePattern.test(file.name)) {
        const date = new Date(file.created_at);
        photos.set(file.name, { path: `${athleteId}/${file.name}`, date });
      }
    }
    if (data.length < pageSize) break;
  }
  return [...photos.values()].sort((a, b) => b.date - a.date);
}

async function decodePhoto(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareProgressPhoto(file) {
  if (!file?.size || file.size > maxFileSize) throw new Error("Scegli una foto fino a 15 MB.");
  const { inspectBiaFile } = await import("./bia-ocr.mjs");
  let type;
  try { ({ type } = await inspectBiaFile(file)); }
  catch { throw new Error("Scegli una foto JPG, PNG, WebP o HEIC."); }
  if (type === "application/pdf") throw new Error("Scegli un file immagine.");
  let image;
  try {
    try {
      image = await decodePhoto(file);
    } catch (error) {
      if (type !== "image/heic") throw error;
      const { heic2any } = await import("../vendor/bia-runtime/bia-runtime.js?v=20261109-workerfix");
      const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      image = await decodePhoto(Array.isArray(converted) ? converted[0] : converted);
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.87));
    if (blob?.type !== "image/jpeg") throw new Error("JPEG non disponibile");
    return blob;
  } catch { throw new Error("Foto illeggibile. Prova a scegliere un’altra immagine."); }
}

export async function saveProgressPhoto(athleteId, name, blob) {
  const path = `${athleteId}/${name}${suffix}`;
  const bucket = supabase.storage.from(PHOTO_BUCKET);
  const { error } = await bucket.upload(path, blob, { contentType: "image/jpeg", cacheControl: "0" });
  if (!error) return;
  // An interrupted response can leave a successfully stored object.
  const { data } = await bucket.createSignedUrl(path, 60).catch(() => ({}));
  if (!data?.signedUrl) throw error;
}

export async function deleteProgressPhoto(path) {
  const { error } = await supabase.storage.from(PHOTO_BUCKET).remove([path]);
  if (error) throw error;
}
