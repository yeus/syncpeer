import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2] === "debug" ? "debug" : "release";
const root = process.cwd();

const candidates = [
  path.join(
    root,
    "packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/universal",
    mode,
    `app-universal-${mode}.apk`,
  ),
  path.join(
    root,
    "packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk",
    mode,
    `app-${mode}.apk`,
  ),
];

const src = candidates.find((p) => fs.existsSync(p));

if (!src) {
  console.error(`Could not find built Android APK for mode=${mode}`);
  console.error("Checked:");
  for (const p of candidates) console.error(`  - ${p}`);
  process.exit(1);
}

const outDir = path.join(root, "dist");
fs.mkdirSync(outDir, { recursive: true });

const dst = path.join(root, `syncpeer-android-${mode}-arm64-v8a.apk`);
const dstInDist = path.join(outDir, `syncpeer-android-${mode}-arm64-v8a.apk`);

fs.copyFileSync(src, dst);
fs.copyFileSync(src, dstInDist);

console.log(`Copied APK:`);
console.log(`  ${dst}`);
console.log(`  ${dstInDist}`);
