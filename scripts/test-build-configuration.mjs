import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { profile } from "./android-emulator.mjs";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the Android release matrix names API 24, 29, and 36 emulator profiles", () => {
  assert.match(profile("legacy").systemImage, /android-24/);
  assert.match(profile("compat").systemImage, /android-29/);
  assert.match(profile("modern").systemImage, /android-36/);
  const runner = fs.readFileSync("scripts/test-android.mjs", "utf8");
  assert.match(runner, /runProfile\("legacy"/);
  const editor = fs.readFileSync("packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/build.gradle.kts", "utf8");
  assert.match(editor, /minSdk = 24/);
});

test("application builds compile the core workspace first", () => {
  const scripts = json("package.json").scripts;
  assert.equal(
    scripts["build:app"],
    "npm run build:core && npm run build -w @syncpeer/app",
  );
});

test("Tauri builds use the dependency-aware application build", () => {
  const configs = [
    [
      "packages/tauri-shell/src-tauri/tauri.conf.json",
      "npm --prefix ../.. run build:app",
    ],
    [
      "packages/tauri-shell/src-tauri/tauri.lan-e2e.conf.json",
      "npm --prefix ../.. run build:app -- -- --mode lan-e2e",
    ],
    [
      "packages/tauri-shell/src-tauri/tauri.android-e2e.conf.json",
      "npm --prefix ../.. run build:app -- -- --mode android-e2e",
    ],
  ];

  for (const [file, expected] of configs) {
    assert.equal(json(file).build.beforeBuildCommand, expected);
  }
});

test("Android release setup uses tools available on standard runners", () => {
  const script = fs.readFileSync("scripts/build-android-prod-with-secrets.sh", "utf8");
  assert.doesNotMatch(script, /\brg\b/);
});

test("Android compatibility testing has one explicit API 29 owner", () => {
  const flake = fs.readFileSync("flake.nix", "utf8");
  const scripts = json("package.json").scripts;
  assert.match(flake, /compatibilityPlatformVersion = "29"/);
  assert.equal(
    scripts["android:emulator:compat"],
    "node scripts/android-emulator.mjs start compat",
  );
  assert.equal(
    scripts["test:android:compat"],
    "npm run build:android:e2e && npm run android:install:e2e && node scripts/test-android-e2e.mjs --expect-sdk 29 --reboot",
  );
});

test("the combined Android workflow owns all three emulator profiles", () => {
  const scripts = json("package.json").scripts;
  const runner = fs.readFileSync("scripts/test-android.mjs", "utf8");
  assert.equal(scripts["test:android"], "node scripts/test-android.mjs");
  assert.match(runner, /build:android:e2e/);
  assert.match(runner, /compat/);
  assert.match(runner, /modern/);
  assert.match(runner, /legacy/);
  assert.match(runner, /test-android-e2e\.mjs/);
  assert.match(runner, /--skip-network/);
  assert.match(runner, /uninstallIfPresent\("dev\.syncpeer\.app"\)/);
  assert.match(runner, /uninstallIfPresent\("dev\.syncpeer\.plugin\.android\.test"\)/);
  assert.match(runner, /dev\.syncpeer\.synthetic\.editor/);
  assert.match(runner, /editorProject, "assembleDebug"/);
});

test("Android network tests cannot silently select a saved external peer", () => {
  const runner = fs.readFileSync("scripts/test-android-e2e.mjs", "utf8");
  assert.doesNotMatch(runner, /\.tmp\/syncpeer-dev-client\/server-device-id/);
});

test("remote CLI diagnostics require an explicit external peer", () => {
  const runner = fs.readFileSync("scripts/test-dev-cli.ts", "utf8");
  assert.doesNotMatch(runner, /server-device-id/);
  assert.match(runner, /externalPeerSkipReason/);
});

test("one-host Tauri tests skip public discovery probes", () => {
  const spec = fs.readFileSync("scripts/lan-test/spec.ts", "utf8");
  const smoke = spec.split('it("reports public discovery reachability')[1];
  assert.ok(smoke);
  assert.match(smoke, /SYNCPEER_LAN_SELF/);
  assert.match(smoke, /this\.skip\(\)/);
});

test("one-host QUIC uses an explicit direct endpoint", () => {
  const spec = fs.readFileSync("scripts/lan-test/spec.ts", "utf8");
  const quic = spec.split('it("connects to a real Syncthing QUIC listener')[1]
    ?.split('it("connects through official global discovery')[0];
  assert.ok(quic);
  assert.match(quic, /connect\(currentFixture, "direct", \{ quicOnly: true \}\)/);
  assert.doesNotMatch(quic, /connect\(currentFixture, "automatic"\)/);
});

test("large desktop cache checks avoid full-byte WebDriver exports", () => {
  const helper = fs.readFileSync("scripts/lan-test/ui-helpers.ts", "utf8");
  assert.match(helper, /__syncpeerDigestCachedFile/);
  assert.doesNotMatch(helper, /syncpeer_read_binary_file/);
  assert.doesNotMatch(helper, /__syncpeerReadCachedBytes/);
});

test("the synthetic document editor is a separate test-only APK", () => {
  const editorSettings = fs.readFileSync(
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/settings.gradle.kts",
    "utf8",
  );
  const manifest = fs.readFileSync(
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/src/main/AndroidManifest.xml",
    "utf8",
  );
  const editorBuild = fs.readFileSync(
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/build.gradle.kts",
    "utf8",
  );
  const editorProvider = fs.readFileSync(
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/src/main/java/dev/syncpeer/synthetic/editor/EditorCommandProvider.kt",
    "utf8",
  );
  const editorTheme = fs.readFileSync(
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/src/main/res/values/styles.xml",
    "utf8",
  );
  assert.match(editorSettings, /rootProject\.name = "syncpeer-document-editor"/);
  assert.match(editorBuild, /applicationId = "dev\.syncpeer\.synthetic\.editor"/);
  assert.doesNotMatch(manifest, /android\.intent\.category\.LAUNCHER/);
  assert.match(manifest, /android:theme="@style\/SyntheticEditorGrantTheme"/);
  assert.match(editorTheme, /Theme\.Translucent\.NoTitleBar/);
  assert.doesNotMatch(manifest, /Theme\.NoDisplay/);
  assert.doesNotMatch(editorProvider, /readNBytes/);
  assert.doesNotMatch(
    fs.readFileSync("packages/tauri-shell/src-tauri/gen/android/app/build.gradle.kts", "utf8"),
    /syncpeer-document-editor/,
  );
});

test("the combined Android workflow provisions WebView without Play Store interaction", () => {
  const runner = fs.readFileSync("scripts/test-android.mjs", "utf8");
  assert.match(runner, /captureWebViewFixture/);
  assert.match(runner, /installWebViewFixture/);
  assert.match(runner, /set-webview-implementation/);
});

test("the Android runtime bridge permits concurrent network reads and writes", () => {
  const service = fs.readFileSync(
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/DocumentRuntimeService.kt",
    "utf8",
  );
  const transport = fs.readFileSync(
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/SessionNetworkTransport.kt",
    "utf8",
  );
  const nativeBridge = fs.readFileSync(
    "packages/tauri-shell/src-tauri/src/android_network.rs",
    "utf8",
  );
  assert.match(service, /networkWorker = Executors\.newFixedThreadPool\([2-9]\)/);
  assert.doesNotMatch(transport, /@Synchronized\s+fun execute/);
  assert.match(nativeBridge, /set_rust_field\([\s\S]*Arc::new\(AndroidNetwork/);
  assert.match(nativeBridge, /Arc::clone\(&network\)/);
});

test("modern Android uses only a focused service smoke test", () => {
  const scripts = json("package.json").scripts;
  assert.equal(
    scripts["android:emulator:modern"],
    "node scripts/android-emulator.mjs start modern",
  );
  assert.equal(
    scripts["test:android:modern-smoke"],
    "npm run build:android:e2e && npm run android:install:e2e && node scripts/test-android-e2e.mjs --modern-smoke",
  );
});

test("Android 10 runs compatibility checks instead of being skipped", () => {
  const script = fs.readFileSync("scripts/test-android-e2e.mjs", "utf8");
  assert.doesNotMatch(script, /Android E2E skipped: Android 14/);
  assert.match(script, /Expected Android API/);
  assert.match(script, /picker\.includes\("com\.android\.documentsui"\)/);
});
