import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";
import { execSync } from "node:child_process";
import { env } from "node:process";
import tauriConfig from "../tauri-shell/src-tauri/tauri.conf.json" with { type: "json" };
import corePackage from "../core/package.json" with { type: "json" };
import { isUiE2eBuildMode } from "./buildMode.ts";
import { resolvePackagedAppVersion } from "./buildInfo.ts";

const resolveBuildCommit = (): string => {
  const configured = [
    env.SYNCPEER_BUILD_COMMIT,
    env.GIT_COMMIT,
    env.CI_COMMIT_SHA,
    env.CI_COMMIT_SHORT_SHA,
  ].find((value) => value?.trim());
  if (configured) return configured.trim();
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

const resolveBuildTimeUtc = (): string => {
  const configured = env.SYNCPEER_BUILD_TIME_UTC?.trim();
  if (configured && !Number.isNaN(Date.parse(configured))) return configured;
  return new Date().toISOString();
};

const BUILD_COMMIT = resolveBuildCommit();
const BUILD_TIME_UTC = resolveBuildTimeUtc();
const APP_VERSION = resolvePackagedAppVersion(tauriConfig);
const CORE_VERSION = resolvePackagedAppVersion(corePackage);

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  define: {
    "import.meta.env.SYNCPEER_APP_VERSION": JSON.stringify(APP_VERSION),
    "import.meta.env.SYNCPEER_CORE_VERSION": JSON.stringify(CORE_VERSION),
    "import.meta.env.SYNCPEER_BUILD_COMMIT": JSON.stringify(BUILD_COMMIT),
    "import.meta.env.SYNCPEER_BUILD_TIME_UTC": JSON.stringify(BUILD_TIME_UTC),
    "import.meta.env.SYNCPEER_LAN_E2E": JSON.stringify(isUiE2eBuildMode(mode)),
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
    strictPort: true,
  },
}));
