import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const args = new Set(process.argv.slice(2));
const checkAndroid = args.has("--android");

const desktopRequired = [
  "packages/tauri-shell/src-tauri/icons/32x32.png",
  "packages/tauri-shell/src-tauri/icons/128x128.png",
  "packages/tauri-shell/src-tauri/icons/128x128@2x.png",
  "packages/tauri-shell/src-tauri/icons/icon.png",
  "packages/tauri-shell/src-tauri/icons/icon.ico",
  "packages/tauri-shell/src-tauri/icons/icon.icns",
];

const androidRequired = [
  "packages/tauri-shell/src-tauri/gen/android/app/src/main/res/mipmap-mdpi/ic_launcher.png",
  "packages/tauri-shell/src-tauri/gen/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png",
  "packages/tauri-shell/src-tauri/gen/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
  "packages/tauri-shell/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
];

const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

const run = (cmd, cmdArgs, description) => {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status ?? "unknown"}.`);
  }
};

const ensureAndroidProjectInitialized = () => {
  const androidRoot = "packages/tauri-shell/src-tauri/gen/android";
  if (exists(androidRoot)) return;
  console.log("Android project not initialized; running `npm run build:android:init`.");
  run("npm", ["run", "build:android:init"], "Android init");
};

const missingDesktop = desktopRequired.filter((item) => !exists(item));
if (checkAndroid) {
  ensureAndroidProjectInitialized();
}
const missingAndroid = checkAndroid
  ? androidRequired.filter((item) => !exists(item))
  : [];

if (missingDesktop.length === 0 && missingAndroid.length === 0) {
  console.log("Tauri icons already exist; skipping generation.");
  process.exit(0);
}

if (missingDesktop.length > 0) {
  console.log("Missing desktop icon assets:");
  for (const item of missingDesktop) console.log(`- ${item}`);
}
if (missingAndroid.length > 0) {
  console.log("Missing Android launcher icon assets:");
  for (const item of missingAndroid) console.log(`- ${item}`);
}

console.log("Generating Tauri icons from manifest...");
run("npm", ["run", "icons:generate"], "Icon generation");
