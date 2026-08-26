import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";
import { execSync } from "node:child_process";
import tauriConfig from "../tauri-shell/src-tauri/tauri.conf.json" with { type: "json" };
import { resolvePackagedAppVersion } from "./buildInfo.ts";

const resolveBuildCommit = (): string => {
  try {
    return execSync("git rev-parse --short=12 HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

const BUILD_COMMIT = resolveBuildCommit();
const BUILD_TIME_UTC = new Date().toISOString();
const APP_VERSION = resolvePackagedAppVersion(tauriConfig);

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  define: {
    __SYNCPEER_APP_VERSION__: JSON.stringify(APP_VERSION),
    __SYNCPEER_BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __SYNCPEER_BUILD_TIME_UTC__: JSON.stringify(BUILD_TIME_UTC),
    __SYNCPEER_LAN_E2E__: JSON.stringify(mode === "lan-e2e"),
  },
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
    host: "127.0.0.1",
    port: 5173,
  },
}));
