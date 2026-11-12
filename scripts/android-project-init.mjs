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

/** Directories Android would otherwise restore without the vault key that protects them. */
const androidBackupDomains = ["root", "file", "database", "sharedpref", "external"];
const androidBackupRules = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
${["cloud-backup", "device-transfer"].map(section => `  <${section}>
${androidBackupDomains.map(domain => `    <exclude domain="${domain}" path="." />`).join("\n")}
  </${section}>`).join("\n")}
</data-extraction-rules>
`;

/** Opt the generated app out of cloud backup and device transfer. */
export const ensureAndroidBackupPolicy = (androidRoot) => {
  const manifestPath = path.join(androidRoot, "app/src/main/AndroidManifest.xml");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const application = /<application\b[^>]*>/;
  if (!application.test(manifest)) {
    throw new Error("Generated Android manifest has no <application> element for the backup policy.");
  }
  const setAttribute = (tag, name, value) => {
    const attribute = `android:${name}="${value}"`;
    const existing = new RegExp(`android:${name}="[^"]*"`);
    if (existing.test(tag)) return tag.replace(existing, attribute);
    // Tauri generates an <application> element with children, not a self-closing tag.
    return tag.replace(/>$/, ` ${attribute}>`);
  };
  const patched = manifest.replace(application, tag => setAttribute(
    setAttribute(tag, "allowBackup", "false"),
    "dataExtractionRules",
    "@xml/syncpeer_backup_rules",
  ));
  const rulesPath = path.join(androidRoot, "app/src/main/res/xml/syncpeer_backup_rules.xml");
  if (patched !== manifest) fs.writeFileSync(manifestPath, patched, "utf8");
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  if (!fs.existsSync(rulesPath) || fs.readFileSync(rulesPath, "utf8") !== androidBackupRules) {
    fs.writeFileSync(rulesPath, androidBackupRules, "utf8");
  }
};

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
