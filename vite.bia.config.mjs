import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/vendor/bia-runtime/",
  publicDir: false,
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm", "module", "browser", "development|production"]
  },
  build: {
    target: "es2022",
    outDir: path.join(root, "www/vendor/bia-runtime"),
    emptyOutDir: true,
    sourcemap: false,
    minify: "oxc",
    rollupOptions: {
      input: path.join(root, "scripts/bia-runtime-entry.mjs"),
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: "bia-runtime.js",
        chunkFileNames: "chunk-[hash].js",
        assetFileNames: "[name]-[hash][extname]"
      }
    }
  },
  worker: { format: "es" }
});
