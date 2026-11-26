import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2] === "debug" ? "debug" : "release";
const root = process.cwd();

const signedCandidates = [
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

const unsignedCandidates = [
  path.join(
    root,
    "packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/universal",
    mode,
    `app-universal-${mode}-unsigned.apk`,
  ),
  path.join(
    root,
    "packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk",
    mode,
    `app-${mode}-unsigned.apk`,
  ),
];

const candidates = mode === "release" ? signedCandidates : [...signedCandidates, ...unsignedCandidates];
const src = candidates.find((p) => fs.existsSync(p));

if (!src) {
  if (mode === "release") {
    const unsignedSrc = unsignedCandidates.find((p) => fs.existsSync(p));
    if (unsignedSrc) {
      console.error("Found only unsigned release APK. Android will reject it with 'App not installed'.");
      console.error("Configure release signing vars before running build:android:prod:");
      console.error("  - ANDROID_KEYSTORE_PATH");
      console.error("  - ANDROID_KEYSTORE_PASSWORD");
      console.error("  - ANDROID_KEY_ALIAS");
      console.error("  - ANDROID_KEY_PASSWORD");
      console.error(`Unsigned APK found at: ${unsignedSrc}`);
      process.exit(1);
    }
  }
  console.error(`Could not find built Android APK for mode=${mode}`);
  console.error("Checked:");
  for (const p of candidates) console.error(`  - ${p}`);
  process.exit(1);
}

// Pin to the certificate on the published v0.5.0 Android release. The override
// is required for the isolated synthetic-key upgrade harness, not normal releases.
const publishedCertificateSha256 = "936a1e27876644667e52b10d7e7e41b53ac39865ae09a2c7e25d5614664a0e59";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const verifyReleaseApk = (apk) => {
  const config = readJson(path.join(root, "packages/tauri-shell/src-tauri/tauri.conf.json"));
  const override = process.env.SYNCPEER_ANDROID_BUILD_CONFIG;
  const expectedVersion = (override && readJson(path.resolve(override)).version) || config.version;
  const metadata = readJson(path.join(path.dirname(apk), "output-metadata.json"));
  const outputName = metadata.elements?.[0]?.outputFile;
  const fileName = path.basename(apk);
  if (metadata.applicationId !== config.identifier ||
      metadata.elements?.[0]?.versionName !== expectedVersion ||
      ![fileName, fileName.replace(/\.apk$/, "-unsigned.apk")].includes(outputName)) {
    throw new Error("Android release APK metadata differs from the expected package, version or output file.");
  }

  const signer = process.env.SYNCPEER_APKSIGNER || "apksigner";
  const result = spawnSync(signer, ["verify", "--print-certs", apk], { encoding: "utf8" });
  const actual = /Signer #1 certificate SHA-256 digest:\s*([a-f0-9]{64})/i
    .exec(result.stdout || "")?.[1]?.toLowerCase();
  const certificateOverride = process.env.SYNCPEER_EXPECTED_ANDROID_CERT_SHA256;
  if (certificateOverride && (!override || process.env.SYNCPEER_ANDROID_TARGET !== "x86_64")) {
    throw new Error("Android signing certificate override is only permitted for isolated x86_64 build-config tests.");
  }
  const expected = (certificateOverride || publishedCertificateSha256)
    .replaceAll(":", "").toLowerCase();
  if (result.status !== 0 || !actual) {
    throw new Error(`Android release APK signature verification failed: ${result.error?.code || result.stderr?.trim() || result.status}`);
  }
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
    throw new Error(`Android signing certificate mismatch: expected ${expected}, received ${actual}. Refusing to distribute a non-upgradeable APK.`);
  }
  console.log(`Verified Android release APK ${expectedVersion}, certificate SHA-256 ${actual}.`);
};

if (mode === "release") verifyReleaseApk(src);

const outDir = path.join(root, "dist");
fs.mkdirSync(outDir, { recursive: true });

const abiLabel = process.env.SYNCPEER_ANDROID_TARGET === "x86_64" ? "x86_64" : "arm64-v8a";
const dst = path.join(root, `syncpeer-android-${mode}-${abiLabel}.apk`);
const dstInDist = path.join(outDir, `syncpeer-android-${mode}-${abiLabel}.apk`);

fs.copyFileSync(src, dst);
fs.copyFileSync(src, dstInDist);

console.log(`Copied APK:`);
console.log(`  ${dst}`);
console.log(`  ${dstInDist}`);
