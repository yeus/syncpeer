import fs from "node:fs";
import path from "node:path";

const requiredFiles = [
  "app/src/main/AndroidManifest.xml",
  "app/build.gradle.kts",
  "app/src/main/java/dev/syncpeer/app/MainActivity.kt",
  "gradlew",
];

/** Directories from signing, icons, or a failed init do not constitute an Android project. */
export const isAndroidProjectInitialized = (androidRoot) =>
  requiredFiles.every(file => fs.existsSync(path.join(androidRoot, file)));

/** Preserve incomplete projects while giving Tauri a clean target for init. */
export const ensureAndroidProjectInitialized = (androidRoot, initialize) => {
  if (isAndroidProjectInitialized(androidRoot)) return null;
  const verify = () => {
    if (!isAndroidProjectInitialized(androidRoot)) {
      throw new Error("Tauri Android init did not generate a complete project (manifest, Gradle, MainActivity and gradlew).");
    }
  };

  if (!fs.existsSync(androidRoot)) {
    initialize();
    verify();
    return null;
  }
  if (!fs.lstatSync(androidRoot).isDirectory()) {
    throw new Error(`Refusing to replace non-directory Android project path: ${androidRoot}`);
  }

  // The backup stays beneath the ignored gen directory, on the same filesystem.
  const backupDir = fs.mkdtempSync(path.join(path.dirname(androidRoot), "android-incomplete-"));
  const original = path.join(backupDir, "previous");
  fs.renameSync(androidRoot, original);
  try {
    initialize();
    verify();
  } catch (error) {
    // Keep failed generation for inspection rather than deleting anything.
    if (fs.existsSync(androidRoot)) {
      fs.renameSync(androidRoot, path.join(backupDir, "failed-init"));
    }
    fs.renameSync(original, androidRoot);
    throw error;
  }
  return original;
};
