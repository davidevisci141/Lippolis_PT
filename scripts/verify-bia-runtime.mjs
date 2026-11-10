import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(root, "www/vendor/bia-runtime");
const bundle = await readFile(path.join(runtimeDir, "bia-runtime.js"), "utf8");
if (!/export\s*\{[^}]*\bas\s+PaddleOCR\b/.test(bundle)) {
  throw new Error("Il bundle BIA non esporta PaddleOCR: la schermata non potrà inizializzare l’OCR.");
}
for (const file of [
  "ort/ort-wasm-simd-threaded.mjs",
  "ort/ort-wasm-simd-threaded.wasm",
  "ort/ort-wasm-simd-threaded.jsep.mjs",
  "ort/ort-wasm-simd-threaded.jsep.wasm"
]) {
  const info = await stat(path.join(runtimeDir, file)).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`Runtime BIA incompleto: manca ${file}.`);
}
if (!(await readdir(runtimeDir)).some((file) => /^worker-entry-.*\.js$/.test(file))) {
  throw new Error("Runtime BIA incompleto: manca il worker OCR.");
}
console.log("Bundle BIA verificato: PaddleOCR, worker e asset ONNX presenti.");
