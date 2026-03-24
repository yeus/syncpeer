import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
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
