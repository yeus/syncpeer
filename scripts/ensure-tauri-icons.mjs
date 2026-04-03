import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const args = new Set(process.argv.slice(2));
const checkAndroid = args.has("--android");
const manifestPath = path.join(
  root,
  "packages/tauri-shell/src-tauri/icon-manifest.json",
);
const markerPath = path.join(
  root,
  "packages/tauri-shell/src-tauri/icons/.manifest-cache.json",
);
const androidAdaptiveLauncherPath = path.join(
  root,
  "packages/tauri-shell/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
);
const androidInsetDrawablePath = path.join(
  root,
  "packages/tauri-shell/src-tauri/gen/android/app/src/main/res/drawable/ic_launcher_foreground_inset.xml",
);

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

const ensureAndroidAdaptiveIconInset = () => {
  if (!checkAndroid) return;
  if (!fs.existsSync(androidAdaptiveLauncherPath)) return;

  const insetDrawable = `<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android"
  android:insetLeft="16dp"
  android:insetTop="16dp"
  android:insetRight="16dp"
  android:insetBottom="16dp">
  <bitmap android:src="@mipmap/ic_launcher_foreground" />
</inset>
`;
  fs.mkdirSync(path.dirname(androidInsetDrawablePath), { recursive: true });
  fs.writeFileSync(androidInsetDrawablePath, insetDrawable, "utf8");

  const launcherXml = fs.readFileSync(androidAdaptiveLauncherPath, "utf8");
  const patched = launcherXml.replace(
    /android:drawable="@mipmap\/ic_launcher_foreground"/g,
    'android:drawable="@drawable/ic_launcher_foreground_inset"',
  );
  if (patched !== launcherXml) {
    fs.writeFileSync(androidAdaptiveLauncherPath, patched, "utf8");
  }
};

const missingDesktop = desktopRequired.filter((item) => !exists(item));
if (checkAndroid) {
  ensureAndroidProjectInitialized();
}
const missingAndroid = checkAndroid
  ? androidRequired.filter((item) => !exists(item))
  : [];

const readJsonOrNull = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const manifestContent = fs.existsSync(manifestPath)
  ? fs.readFileSync(manifestPath, "utf8")
  : "";
const previousMarker = readJsonOrNull(markerPath);
const manifestChanged = previousMarker?.manifestContent !== manifestContent;

if (missingDesktop.length === 0 && missingAndroid.length === 0 && !manifestChanged) {
  ensureAndroidAdaptiveIconInset();
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
if (manifestChanged) {
  console.log("Icon manifest changed; regenerating icon assets.");
}

console.log("Generating Tauri icons from manifest...");
run("npm", ["run", "icons:generate"], "Icon generation");
ensureAndroidAdaptiveIconInset();
fs.writeFileSync(
  markerPath,
  JSON.stringify({ manifestContent, generatedAtMs: Date.now() }, null, 2),
  "utf8",
);
