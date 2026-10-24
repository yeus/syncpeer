import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { profile } from "./android-emulator.mjs";
import { patchManifest } from "./prepare-android-legacy-launcher.mjs";
import { webViewSelected } from "./test-android.mjs";

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

test("Android release validation can use isolated emulator names", () => {
  assert.equal(profile("legacy", "syncpeer-release").avdName, "syncpeer-release-api24");
  assert.equal(profile("compat", "syncpeer-release").avdName, "syncpeer-release-api29");
  assert.equal(profile("modern", "syncpeer-release").avdName, "syncpeer-release-api36-play");
  assert.throws(() => profile("legacy", "../other"), /AVD prefix/);
});

test("Android builds keep the unsupported launcher separate from the Tauri activity", () => {
  const source = '<manifest><application><activity android:name=".MainActivity">' +
    '<intent-filter /></activity></application></manifest>';
  const patched = patchManifest(source);
  assert.match(patched, /MainActivity"[\s\S]*syncpeer_modern_activity/);
  assert.match(patched, /UnsupportedAndroidActivity"[\s\S]*syncpeer_legacy_activity/);
  assert.equal(patchManifest(patched), patched);
  const scripts = json("packages/tauri-shell/package.json").scripts;
  for (const name of ["prebuild:android:dev", "prebuild:android:e2e", "prebuild:android:prod"]) {
    assert.match(scripts[name], /prepare-android-legacy-launcher/);
  }
  const legacy = fs.readFileSync("scripts/android-legacy-launcher/values/launcher.xml", "utf8");
  const modern = fs.readFileSync("scripts/android-legacy-launcher/values-v26/launcher.xml", "utf8");
  assert.match(legacy, /syncpeer_legacy_activity">true/);
  assert.match(modern, /syncpeer_modern_activity">true/);
});

test("API 29 waits for the provisioned WebView to become current", () => {
  const version = "133.0.6943.137";
  assert.equal(webViewSelected("Current WebView package is null", version), false);
  assert.equal(webViewSelected(
    `Preferred WebView package (name, version): (com.google.android.webview, ${version})`, version), false);
  assert.equal(webViewSelected(
    `Current WebView package (name, version): (com.google.android.webview, ${version})`, version), true);
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

test("packaged screenshot capture ensures ignored Tauri icons before building", () => {
  const script = fs.readFileSync("scripts/capture-screenshots.mjs", "utf8");
  assert.match(
    script,
    /run\("npm", \["run", "icons:ensure", "-w", "@syncpeer\/tauri-shell"\]\);[\s\S]*?run\("npx", \[[\s\S]*?"tauri", "build"/,
  );
});

test("packaged pairing spec parses with the TypeScript loader before acceptance", () => {
  const require = createRequire(import.meta.resolve("tsx"));
  const { transformSync } = require("esbuild");
  const spec = fs.readFileSync("scripts/lan-test/packaged-pairing.spec.ts", "utf8");
  assert.doesNotThrow(() => transformSync(spec, {
    loader: "ts",
    sourcefile: "scripts/lan-test/packaged-pairing.spec.ts",
  }));
});
test("packaged pairing targets the joiner's actual password input", () => {
  const settings = fs.readFileSync("packages/app/src/GeneralSettingsPage.svelte", "utf8");
  const spec = fs.readFileSync("scripts/lan-test/packaged-pairing.spec.ts", "utf8");
  assert.match(settings,
    /<PasswordInput label="New local master password"[\s\S]*?testId="pairing-new-master-password"/);
  assert.ok(spec.includes("[data-testid='pairing-new-master-password']"),
    "The packaged pairing test must use the input's stable test ID.");
  assert.doesNotMatch(spec, /label\[contains\(\., 'New local master password'\)\]\/input/,
    "A PasswordInput renders its label and input as siblings, not nested elements.");
});


test("packaged screenshots use focused-window capture in screenshot environments", () => {
  const spec = fs.readFileSync("scripts/lan-test/packaged-pairing.spec.ts", "utf8");
  assert.match(spec, /spawnSync\("scrot", \["-u",/);
  assert.doesNotMatch(spec, /\.saveScreenshot\(/);
  for (const file of [
    ".github/workflows/screenshots.yml",
    ".github/workflows/release.yml",
  ]) {
    assert.match(fs.readFileSync(file, "utf8"), /\n\s+scrot\s+\\/);
  }
  assert.match(fs.readFileSync("flake.nix", "utf8"), /\n\s+scrot\s*\n/);
});

test("desktop screenshot focus permission is limited to LAN E2E builds", () => {
  const root = "packages/tauri-shell/src-tauri";
  const permission = "core:window:allow-set-focus";
  const e2e = json(`${root}/tauri.lan-e2e.conf.json`);
  assert.ok(e2e.app.security.capabilities
    .flatMap(capability => capability.permissions).includes(permission));
  const production = json(`${root}/tauri.conf.json`);
  for (const capability of production.app.security.capabilities) {
    const permissions = typeof capability === "string"
      ? json(`${root}/capabilities/${capability}.json`).permissions
      : capability.permissions;
    assert.ok(!permissions.some(value =>
      (typeof value === "string" ? value : value.identifier) === permission),
    "Screenshot focus permission must remain outside production capabilities.");
  }
});

test("the virtual desktop uses software rendering, preserves target failures and stops its window manager", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-virtual-desktop-test-"));
  const pidFile = path.join(root, "wm.pid");
  context.after(() => {
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, "utf8").trim()), "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "openbox"),
    '#!/bin/sh\nprintf "%s\\n" "$$" > "$SYNCPEER_FAKE_WM_PID"\n' +
    "trap 'exit 0' TERM\nwhile :; do sleep 0.05; done\n", { mode: 0o700 });
  fs.writeFileSync(path.join(root, "xprop"),
    '#!/bin/sh\ntest -s "$SYNCPEER_FAKE_WM_PID" || exit 1\n' +
    'printf "%s\\n" "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x1234"\n',
    { mode: 0o700 });
  const result = spawnSync("bash", ["scripts/lan-test/virtual-desktop.sh",
    "--inside-xvfb", "sh", "-c", [
      'test "$WEBKIT_DISABLE_DMABUF_RENDERER" = 1 || exit 9',
      'test "$LIBGL_ALWAYS_SOFTWARE" = 1 || exit 9',
      'test "$GALLIUM_DRIVER" = llvmpipe || exit 9',
      "exit 7",
    ].join("\n")], {
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SYNCPEER_FAKE_WM_PID: pidFile,
      WEBKIT_DISABLE_DMABUF_RENDERER: "0", LIBGL_ALWAYS_SOFTWARE: "0", GALLIUM_DRIVER: "synthetic-hardware" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 7, result.stderr);
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("screenshot environments provide a window manager and its readiness probe", () => {
  for (const file of [".github/workflows/screenshots.yml", ".github/workflows/release.yml"]) {
    const workflow = fs.readFileSync(file, "utf8");
    assert.match(workflow, /\n\s+openbox\s*\\/);
    assert.match(workflow, /\n\s+x11-utils\s*\\/);
  }
  const shell = fs.readFileSync("flake.nix", "utf8");
  assert.match(shell, /\n\s+openbox\s*\n/);
  assert.match(shell, /\n\s+xorg\.xprop\s*\n/);
});

test("Android release setup uses tools available on standard runners", () => {
  const script = fs.readFileSync("scripts/build-android-prod-with-secrets.sh", "utf8");
  assert.doesNotMatch(script, /\brg\b/);
});

test("Android CI lets the project install its pinned SDK packages", () => {
  for (const file of [".github/workflows/android-build.yml", ".github/workflows/release.yml"]) {
    const workflow = fs.readFileSync(file, "utf8");
    const setup = workflow.match(/uses: android-actions\/setup-android@v3\n([\s\S]*?)(?=\n\s+- name:)/);
    assert.ok(setup, `${file} must configure the Android SDK action.`);
    assert.match(setup[1], /with:\n\s+packages: ""/,
      `${file} must skip the action's default SDK package install.`);
  }
});

test("Android CI isolates the pinned NDK from runner image upgrades", () => {
  for (const file of [".github/workflows/android-build.yml", ".github/workflows/release.yml"]) {
    const workflow = fs.readFileSync(file, "utf8");
    assert.match(workflow, /sdk_root="\$RUNNER_TEMP\/syncpeer-android-sdk"/,
      `${file} must use an isolated Android SDK root.`);
    assert.match(workflow, /sdkmanager --sdk_root="\$sdk_root"/,
      `${file} must install packages into the isolated SDK root.`);
    assert.match(workflow, /echo "ANDROID_HOME=\$sdk_root"/);
    assert.match(workflow, /echo "ANDROID_SDK_ROOT=\$sdk_root"/);
    assert.match(workflow, /echo "ANDROID_NDK_HOME=\$sdk_root\/ndk\/\$\{ANDROID_NDK_VERSION\}"/);
    assert.match(workflow, /echo "ANDROID_NDK_ROOT=\$sdk_root\/ndk\/\$\{ANDROID_NDK_VERSION\}"/);
    assert.match(workflow, /find "\$ANDROID_SDK_ROOT\/ndk".*wc -l.*-eq 1/,
      `${file} must reject accidental extra NDK versions in the isolated SDK.`);
  }
});

test("Android CI configures OpenSSL's NDK ranlib alias", (t) => {
  for (const file of [".github/workflows/android-build.yml", ".github/workflows/release.yml"]) {
    const workflow = fs.readFileSync(file, "utf8");
    const verifyIndex = workflow.indexOf("- name: Verify pinned Android NDK");
    const configureIndex = workflow.indexOf("run: bash scripts/prepare-android-ndk-ranlib.sh");
    const buildStep = file.endsWith("release.yml")
      ? "- name: Build signed Android APK"
      : "- name: Build Android release APK";
    const buildIndex = workflow.indexOf(buildStep);
    assert.ok(verifyIndex >= 0 && configureIndex > verifyIndex && buildIndex > configureIndex,
      `${file} must configure the ranlib alias after NDK verification and before the Android build.`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-ndk-ranlib-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const ndkBin = path.join(tempRoot, "toolchains/llvm/prebuilt/linux-x86_64/bin");
  const githubPath = path.join(tempRoot, "github-path");
  fs.mkdirSync(ndkBin, { recursive: true });
  fs.writeFileSync(path.join(ndkBin, "llvm-ranlib"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(githubPath, "");

  const result = spawnSync("bash", ["scripts/prepare-android-ndk-ranlib.sh"], {
    encoding: "utf8",
    env: { ...process.env, ANDROID_NDK_HOME: tempRoot, GITHUB_PATH: githubPath },
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const alias = path.join(ndkBin, "aarch64-linux-android-ranlib");
  assert.equal(fs.realpathSync(alias), path.join(ndkBin, "llvm-ranlib"));
  assert.equal(fs.readFileSync(githubPath, "utf8"), `${ndkBin}\n`);
});


test("Android license acceptance tolerates producer SIGPIPE but preserves SDK failures", () => {
  for (const file of [".github/workflows/android-build.yml", ".github/workflows/release.yml"]) {
    const workflow = fs.readFileSync(file, "utf8");
    const acceptance = workflow.split("\n").find(line => line.includes("yes | sdkmanager"));
    assert.ok(acceptance, `${file} must accept licenses for the isolated SDK.`);
    for (const sdkStatus of [0, 42]) {
      const result = spawnSync("bash", ["-c", `
        set -euo pipefail
        sdk_root=synthetic-sdk
        sdkmanager() { head -n 1 >/dev/null; return ${sdkStatus}; }
        ${acceptance.trim()}
      `], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, sdkStatus,
        `${file} must report sdkmanager's status, independently of yes exiting on SIGPIPE.`);
    }
  }
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

test("the packaged desktop-to-Android gate requires an explicit disposable emulator", () => {
  const runner = fs.readFileSync("scripts/test-tauri-deb.mjs", "utf8");
  assert.match(runner, /SYNCPEER_ANDROID_SERIAL/);
  assert.match(runner, /SYNCPEER_ANDROID_RESET_EMULATOR/);
  assert.match(runner, /--cross-app-only/);
  assert.match(runner, /ro\.kernel\.qemu/);
  assert.match(runner, /packaged-android-pairing\.spec\.ts/);
  assert.match(runner, /SYNCPEER_LAN_MOCHA_TIMEOUT: "900000"/);
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

test("real-peer Android acceptance cannot skip a failed document runtime probe", () => {
  const runner = fs.readFileSync("scripts/test-android-peer.ts", "utf8");
  assert.doesNotMatch(runner, /JS_FEATURE_MESSAGE_PORTS required by the document runtime/);
  assert.match(runner, /throw new Error\("Android document runtime is unavailable/);
});
