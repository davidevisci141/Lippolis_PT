import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ortDir = path.join(root, "node_modules/onnxruntime-web/dist");
const wasmDir = path.join(root, "www/vendor/bia-runtime/ort");
await mkdir(wasmDir, { recursive: true });
for (const file of [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm"
]) {
  await copyFile(path.join(ortDir, file), path.join(wasmDir, file));
}
// Vite fingerprints imported ONNX wasm assets; wasmPaths uses stable filenames in /ort instead.
for (const file of await readdir(path.join(root, "www/vendor/bia-runtime"))) {
  if (/^ort-wasm-simd-threaded(?:\.jsep)?-[a-z0-9_-]+\.wasm$/i.test(file)) {
    await rm(path.join(root, "www/vendor/bia-runtime", file), { force: true });
  }
}
const paddle = await readFile(path.join(root, "node_modules/@paddleocr/paddleocr-js/package.json"), "utf8").then(JSON.parse);
const opencv = await readFile(path.join(root, "node_modules/@techstark/opencv-js/package.json"), "utf8").then(JSON.parse);
const onnx = await readFile(path.join(root, "node_modules/onnxruntime-web/package.json"), "utf8").then(JSON.parse);
await writeFile(path.join(root, "www/vendor/bia-runtime/LICENSES.txt"), `OCR runtime assets\n\n@paddleocr/paddleocr-js ${paddle.version}: ${paddle.license}\n@techstark/opencv-js ${opencv.version}: ${opencv.license}\nONNX Runtime Web ${onnx.version}: ${onnx.license}\npdfjs-dist: Apache-2.0\nheic2any: MIT\n\nOCR model assets are loaded from the PaddlePaddle official model host. The selected report file is processed locally in the browser and is not sent to that host.\n`, "utf8");
