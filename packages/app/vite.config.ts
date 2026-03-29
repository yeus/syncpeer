import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  resolve: {
    alias: [
      {
        find: /^@syncpeer\/core\/browser$/,
        replacement: fileURLToPath(new URL("../core/src/browser.ts", import.meta.url)),
      },
      {
        find: /^@syncpeer\/core\/node$/,
        replacement: fileURLToPath(new URL("../core/src/node.ts", import.meta.url)),
      },
      {
        find: /^@syncpeer\/core$/,
        replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      },
    ],
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: mode === "development",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
}));
