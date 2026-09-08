import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = path.join(root, "packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/build/generated/document-runtime/assets");
const result = await build({
  configFile: false,
  root,
  // The package's browser entry assumes an existing browser implementation.
  // JavaScriptEngine needs the actual polyfill, while TS uses its public types.
  resolve: { alias: [{ find: /^abort-controller$/, replacement: createRequire(import.meta.url).resolve("abort-controller/dist/abort-controller.mjs") }] },
  define: { "import.meta.url": "undefined" },
  build: {
    write: false,
    target: "esnext",
    minify: false,
    lib: { entry: path.join(root, "packages/tauri-shell/src/document-runtime.ts"), formats: ["es"] },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(result => result.output);
if (outputs.length !== 1 || outputs[0].type !== "chunk") throw new Error("Document runtime must be one self-contained script.");
await fs.mkdir(outDir, { recursive: true });
// BEP schema loading is asynchronous. Script evaluation supports promises but
// not ES modules, so wrap the bundled, import-free entry in an async function.
await fs.writeFile(path.join(outDir, "syncpeer-documents.js"), `(async () => {\n${outputs[0].code}\nreturn "ready";\n})()`);
