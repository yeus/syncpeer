import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generated = path.join(root, "packages/tauri-shell/src-tauri/gen/android/app/src/main");
const templates = path.join(root, "scripts/android-legacy-launcher");
const mainMarker = 'android:name=".MainActivity"';
const legacyMarker = 'android:name=".UnsupportedAndroidActivity"';

export const patchManifest = (manifest) => {
  const mainStart = manifest.indexOf(mainMarker);
  if (mainStart < 0) throw new Error("Generated Android manifest has no Syncpeer main activity.");
  const mainEnd = manifest.indexOf("</activity>", mainStart);
  if (mainEnd < 0) throw new Error("Generated Android main activity is incomplete.");
  let next = manifest;
  if (!next.slice(mainStart, mainEnd).includes("@bool/syncpeer_modern_activity")) {
    next = next.replace(mainMarker, mainMarker + '\n            android:enabled="@bool/syncpeer_modern_activity"');
  }
  if (!next.includes(legacyMarker)) {
    const end = next.indexOf("</activity>", next.indexOf(mainMarker)) + "</activity>".length;
    const legacy = `

        <activity
            android:name=".UnsupportedAndroidActivity"
            android:enabled="@bool/syncpeer_legacy_activity"
            android:exported="true"
            android:label="@string/main_activity_title">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>`;
    next = next.slice(0, end) + legacy + next.slice(end);
  }
  return next;
};

const copyTemplate = (source, destination) => {
  const content = fs.readFileSync(path.join(templates, source));
  fs.mkdirSync(path.dirname(path.join(generated, destination)), { recursive: true });
  fs.writeFileSync(path.join(generated, destination), content);
};

export const prepareAndroidLegacyLauncher = () => {
  const manifestPath = path.join(generated, "AndroidManifest.xml");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const patched = patchManifest(manifest);
  if (patched !== manifest) fs.writeFileSync(manifestPath, patched);
  copyTemplate("UnsupportedAndroidActivity.kt",
    "java/dev/syncpeer/app/UnsupportedAndroidActivity.kt");
  copyTemplate("values/launcher.xml", "res/values/launcher.xml");
  copyTemplate("values-v26/launcher.xml", "res/values-v26/launcher.xml");
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareAndroidLegacyLauncher();
}
