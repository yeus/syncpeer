import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { profile } from "./android-emulator.mjs";
import { isAndroidProjectInitialized, ensureAndroidProjectInitialized } from "./android-project-init.mjs";
import { webViewSelected } from "./test-android.mjs";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("Android 0.7.0 supports API 26, 29 and 36 only", () => {
  assert.equal(json("packages/tauri-shell/src-tauri/tauri.conf.json").bundle.android.minSdkVersion, 26,
    "Tauri must regenerate an API-26 Android project rather than reverting to its API-24 default.");
  assert.match(profile("minimum").systemImage, /android-26/);
  assert.equal(profile("minimum").systemImage, "system-images;android-26;google_apis;x86_64");
  const flake = fs.readFileSync("flake.nix", "utf8");
  assert.match(flake, /minimumPlatformVersion = "26"/);
  assert.match(flake, /systemImageTypes = \[ "google_apis_playstore" "google_apis" \]/);
  assert.match(flake, /android\.minimumPlatformVersion/);
  assert.match(profile("compat").systemImage, /android-29/);
  assert.match(profile("modern").systemImage, /android-36/);
  assert.throws(() => profile("legacy"), /Unknown Android emulator profile/);
  const runner = fs.readFileSync("scripts/test-android.mjs", "utf8");
  assert.match(runner, /runProfile\("minimum"/);
  assert.doesNotMatch(runner, /runProfile\("legacy"/);
  for (const file of [
    "packages/tauri-shell/src-tauri/gen/android/app/build.gradle.kts",
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/build.gradle.kts",
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/build.gradle.kts",
  ]) assert.match(fs.readFileSync(file, "utf8"), /minSdk = 26/);
});

test("Android minimum WebView build target stays Chrome 69 compatible", () => {
  assert.match(fs.readFileSync("packages/app/vite.config.ts", "utf8"), /target: "chrome69"/);
  const documentRuntime = fs.readFileSync("scripts/build-document-runtime.mjs", "utf8");
  assert.match(documentRuntime, /target: "chrome69"/);
  assert.match(documentRuntime, /window\.globalThis = window/);
  assert.match(fs.readFileSync("packages/app/index.html", "utf8"), /window\.globalThis = window/);
});

test("Android release validation can use isolated emulator names", () => {
  assert.equal(profile("minimum", "syncpeer-release").avdName, "syncpeer-release-api26");
  assert.equal(profile("compat", "syncpeer-release").avdName, "syncpeer-release-api29");
  assert.equal(profile("modern", "syncpeer-release").avdName, "syncpeer-release-api36-play");
  assert.throws(() => profile("minimum", "../other"), /AVD prefix/);
});

test("Android builds use one launcher and bootstrap generated files first", () => {
  const scripts = json("packages/tauri-shell/package.json").scripts;
  for (const name of ["preandroid:dev", "prebuild:android:dev", "prebuild:android:e2e", "prebuild:android:prod"]) {
    assert.equal(scripts[name], "npm run icons:ensure:android");
  }
  assert.equal(scripts["postandroid:init"], undefined);
  const manifest = fs.readFileSync("packages/tauri-shell/src-tauri/gen/android/app/src/main/AndroidManifest.xml", "utf8");
  assert.doesNotMatch(manifest, /UnsupportedAndroidActivity|syncpeer_modern_activity/);
});

const writeSyntheticAndroidProject = (android) => {
  for (const [name, content] of [
    ["app/src/main/AndroidManifest.xml", "<manifest />"],
    ["app/build.gradle.kts", "plugins {}"],
    ["app/src/main/java/dev/syncpeer/app/MainActivity.kt", "class MainActivity"],
    ["gradlew", "#!/bin/sh"],
  ]) {
    const file = path.join(android, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
};

test("Android init requires MainActivity and Gradle wrapper, not just signing directories", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-android-init-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const android = path.join(temp, "gen/android");
  const mainActivity = path.join(android, "app/src/main/java/dev/syncpeer/app/MainActivity.kt");
  assert.equal(isAndroidProjectInitialized(android), false);
  fs.mkdirSync(path.join(android, "app"), { recursive: true });
  fs.writeFileSync(path.join(android, "keystore.properties"), "synthetic signing data");
  assert.equal(isAndroidProjectInitialized(android), false);
  writeSyntheticAndroidProject(android);
  assert.equal(isAndroidProjectInitialized(android), true);
  fs.rmSync(mainActivity);
  assert.equal(isAndroidProjectInitialized(android), false);
  fs.writeFileSync(mainActivity, "class MainActivity");
  fs.rmSync(path.join(android, "gradlew"));
  assert.equal(isAndroidProjectInitialized(android), false);
});

test("partial Android init preserves existing files when regenerated", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-android-recovery-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const android = path.join(temp, "gen/android");
  fs.mkdirSync(path.join(android, "app"), { recursive: true });
  fs.writeFileSync(path.join(android, "custom.txt"), "user content");
  fs.writeFileSync(path.join(android, "keystore.properties"), "existing signing property");
  let calls = 0;
  const archive = ensureAndroidProjectInitialized(android, () => {
    calls += 1;
    assert.equal(fs.existsSync(android), false,
      "Tauri must initialize without an incomplete gen/android directory");
    writeSyntheticAndroidProject(android);
  });
  assert.equal(calls, 1);
  assert.equal(isAndroidProjectInitialized(android), true);
  assert.ok(archive);
  assert.equal(fs.readFileSync(path.join(archive, "custom.txt"), "utf8"), "user content");
  assert.equal(fs.readFileSync(path.join(archive, "keystore.properties"), "utf8"), "existing signing property");
  assert.equal(ensureAndroidProjectInitialized(android, () => { throw Error("Should not reinitialize"); }), null);
});

test("failed Android init restores the incomplete original without discarding new data", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-android-rollback-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const android = path.join(temp, "gen/android");
  fs.mkdirSync(android, { recursive: true });
  fs.writeFileSync(path.join(android, "custom.txt"), "keep me");
  assert.throws(() => ensureAndroidProjectInitialized(android, () => {
    fs.mkdirSync(android, { recursive: true });
    fs.writeFileSync(path.join(android, "partial-init.txt"), "new work");
    throw Error("Synthetic Tauri initialization failure");
  }), /Synthetic Tauri initialization failure/);
  assert.equal(fs.readFileSync(path.join(android, "custom.txt"), "utf8"), "keep me");
  const [backup] = fs.readdirSync(path.join(temp, "gen"))
    .filter(name => name.startsWith("android-incomplete-"));
  assert.ok(backup, "Failed init files must be preserved outside the restored original");
  assert.equal(fs.readFileSync(path.join(temp, "gen", backup, "failed-init/partial-init.txt"), "utf8"), "new work");
  assert.throws(() => ensureAndroidProjectInitialized(android, () => undefined), /did not generate a complete project/);
  assert.equal(fs.readFileSync(path.join(android, "custom.txt"), "utf8"), "keep me");
});

test("Android bootstrap refuses to move a non-directory project path", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-android-file-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const android = path.join(temp, "android");
  fs.writeFileSync(android, "user file");
  assert.throws(() => ensureAndroidProjectInitialized(android, () => undefined), /Refusing to replace/);
  assert.equal(fs.readFileSync(android, "utf8"), "user file");
});

test("Android build hooks initialize before manifest patching and temporary signing files", () => {
  const scripts = json("packages/tauri-shell/package.json").scripts;
  for (const name of ["preandroid:dev", "prebuild:android:dev", "prebuild:android:e2e", "prebuild:android:prod"]) {
    assert.equal(scripts[name], "npm run icons:ensure:android");
  }
  const icons = fs.readFileSync("scripts/ensure-tauri-icons.mjs", "utf8");
  assert.match(icons, /ensureAndroidProjectInitialized\(androidRoot, \(\) =>/);
  const signing = fs.readFileSync("scripts/build-android-prod-with-secrets.sh", "utf8");
  const bootstrap = signing.indexOf("npm run icons:ensure:android");
  const signingFiles = signing.indexOf('create_gradle_keystore_properties "$path"');
  assert.ok(bootstrap >= 0 && signingFiles > bootstrap,
    "Generated Android project initialization must precede temporary signing properties.");
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

test("packaged attachment waits for the folder-settings control, preserving failure diagnostics", () => {
  const spec = fs.readFileSync("scripts/lan-test/packaged-pairing.spec.ts", "utf8");
  const helper = spec.split("async function attachAndFavoriteSharedFolder(")[1]
    ?.split('describe("Two isolated packaged desktop apps"')[0];
  assert.ok(helper, "The packaged shared-folder helper must exist.");
  assert.match(helper, /\$\("\[data-testid='folder-settings-page'\]"\)\s*\.\$\("button=Reattach encrypted local storage"\)/);
  assert.match(helper, /await attach\.waitForExist\(/);
  assert.doesNotMatch(helper, /\/\/li\[\.\/span\[/,
    "FolderSettingsPage has no legacy li/span folder-name row.");
  assert.doesNotMatch(helper, /\[data-testid='tab-devices'\]/,
    "The Devices tab is not mounted while folder settings are displayed.");
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

test("the combined Android workflow covers API 26, 29 and 36", () => {
  const scripts = json("package.json").scripts;
  const runner = fs.readFileSync("scripts/test-android.mjs", "utf8");
  assert.equal(scripts["test:android"], "node scripts/test-android.mjs");
  assert.match(runner, /build:android:e2e/);
  assert.match(runner, /compat/);
  assert.match(runner, /modern/);
  assert.match(runner, /minimum/);
  assert.doesNotMatch(runner, /runProfile\("legacy"/);
  assert.match(runner, /test-android-e2e\.mjs/);
  assert.match(runner, /--skip-network/);
  assert.match(runner, /uninstallIfPresent\("dev\.syncpeer\.app"\)/);
  assert.match(runner, /uninstallIfPresent\("dev\.syncpeer\.plugin\.android\.test"\)/);
  assert.match(runner, /dev\.syncpeer\.synthetic\.editor/);
  assert.match(runner, /editorProject, "assembleDebug"/);
});

test("Android service exposes same-UID private session commands without opening a second peer", () => {
  const base = "packages/tauri-shell/src-tauri/plugins/syncpeer-android";
  const provider = fs.readFileSync(base + "/android/src/main/java/dev/syncpeer/plugin/android/SyncpeerDocumentsProvider.kt", "utf8");
  const plugin = fs.readFileSync(base + "/android/src/main/java/dev/syncpeer/plugin/android/SyncpeerAndroidPlugin.kt", "utf8");
  const mobile = fs.readFileSync(base + "/src/mobile.rs", "utf8");
  const app = fs.readFileSync("packages/tauri-shell/src-tauri/src/lib.rs", "utf8");
  assert.match(provider, /method != "syncpeerSessionCommand"/);
  assert.match(provider, /Binder.getCallingUid\(\) == context!!\.applicationInfo\.uid/);
  assert.match(provider, /owner\.sessionCommand\(request\)/);
  assert.match(plugin, /fun sessionCommand\(invoke: Invoke\)/);
  assert.match(mobile, /pub fn session_command\(/);
  assert.match(app, /async fn syncpeer_android_session_command\(/);
  assert.match(app, /\s+syncpeer_android_session_command,/);
});
test("Android visibility demotes the existing service without disconnecting its peer socket", () => {
  const path = "packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/DocumentRuntimeService.kt";
  const kotlin = fs.readFileSync(path, "utf8");
  const marker = 'if (input.optString("operation") == "uiVisible") {';
  const offset = kotlin.indexOf(marker);
  const uiVisible = offset < 0 ? null : kotlin.slice(offset, kotlin.indexOf("return result", offset));
  assert.ok(uiVisible, "Service must implement a native UI-visible lifecycle command.");
  assert.match(uiVisible, /stopForeground/);
  assert.doesNotMatch(uiVisible, /stopSession\(|disconnect/);
  const schedule = kotlin.slice(kotlin.indexOf("private fun scheduleBackgroundSession"), kotlin.indexOf("if (sessionRequest == request"));
  assert.ok(schedule);
  assert.match(schedule, /ensureForeground\(\)/);
});
test("Android session stop cannot report idle after a transport shutdown timeout", () => {
  const kotlin = fs.readFileSync("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/DocumentRuntimeService.kt", "utf8");
  const start = kotlin.indexOf("private fun stopSession(");
  const end = kotlin.indexOf("private fun ensureForeground()", start);
  const stop = kotlin.slice(start, end);
  assert.match(stop, /finishSessionStop\(generation, result, error\)/);
  assert.match(stop, /if \(error != null\)/);
  assert.match(stop, /result\.completeExceptionally/);
  assert.match(stop, /sessionPhase = "error"/);
  assert.match(stop, /sessionPhase = "idle"/);
});
test("Android UI connect and disconnect update the service-owned session inventory", () => {
  const kotlin = fs.readFileSync("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/DocumentRuntimeService.kt", "utf8");
  const handler = kotlin.slice(kotlin.indexOf("fun sessionCommand(input:"), kotlin.indexOf("internal fun startBackgroundSession("));
  assert.match(handler, /operation == "disconnect"/);
  assert.match(handler, /stopSession\(persist = true\)/);
  assert.match(handler, /sessionStarted = true/);
  assert.match(handler, /sessionPhase =/);
});


test("disabling background persistence clears native handoff but preserves foreground peer", () => {
  const base = "packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android";
  const service = fs.readFileSync(base + "/DocumentRuntimeService.kt", "utf8");
  const plugin = fs.readFileSync(base + "/SyncpeerAndroidPlugin.kt", "utf8");
  const scope = service.slice(service.indexOf("fun sessionCommand(input:"), service.indexOf("internal fun startBackgroundSession("));
  assert.match(scope, /operation == "disarmBackground"/);
  assert.match(scope, /backgroundSessions\.clear\(\)/);
  assert.doesNotMatch(scope.slice(scope.indexOf('operation == "disarmBackground"'),
    scope.indexOf('operation == "disconnect"')), /stopSession\(/);
  const bridge = plugin.slice(plugin.indexOf("fun sessionCommand(invoke:"), plugin.indexOf("fun releaseLocalCopy(invoke:"));
  assert.match(bridge, /backgroundSessionHandoff\.clear\(\)/);
});
test("Android loss of service binder during stop is not reported as a confirmed shutdown", () => {
  const plugin = fs.readFileSync("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/SyncpeerAndroidPlugin.kt", "utf8");
  const stop = plugin.slice(plugin.indexOf("fun stopBackgroundSession(invoke:"), plugin.indexOf("fun updateTransferNotification(invoke:"));
  assert.match(stop, /override fun onServiceDisconnected/);
  assert.doesNotMatch(stop, /override fun onServiceDisconnected[^}]*finish\(null\)/s);
  assert.match(stop, /finish\("Background synchronization shutdown was not confirmed/);
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
});

test("generated Android Gradle project excludes the synthetic editor", (t) => {
  const generated = "packages/tauri-shell/src-tauri/gen/android/app/build.gradle.kts";
  if (!fs.existsSync(generated)) {
    t.skip("Android Gradle project has not been generated in this checkout");
    return;
  }
  assert.doesNotMatch(fs.readFileSync(generated, "utf8"), /syncpeer-document-editor/);
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

test("Android automatic discovery E2E requires a real outgoing connection and remote index", () => {
  const runner = fs.readFileSync("scripts/test-android-peer.ts", "utf8");
  const phase = fs.readFileSync("scripts/test-android-e2e.mjs", "utf8");
  assert.match(runner, /SYNCPEER_ANDROID_PEER_DISCOVERY_MODE/);
  assert.match(runner, /const outboundOnly = discoveryMode !== "direct"/);
  assert.match(runner, /discovery\.lookupCount\(\) === 0/);
  // Syncthing reports 56-character IDs with check digits, while the client
  // queries with normalized 52-character IDs. The fake server must compare
  // the same canonical form or silently respond 404 to valid peer lookups.
  assert.match(runner, /normalizeDeviceId\(remoteId\)/);
  // The test's HTTPS server lives on the parent event loop; a synchronous
  // child process would block every lookup and make discovery always time out.
  assert.match(runner, /const runPhase = async/);
  assert.match(runner, /spawn\(process\.execPath/);
  assert.match(runner, /await runPhase\("--peer-connect-smoke"/);
  assert.match(runner, /SYNCPEER_ANDROID_PEER_POWER_CUT_ONLY/);
  assert.match(runner, /await runPhase\("--peer-power-cut-setup"/);
  assert.match(runner, /acquirePeerE2ELock/);
  // Preserve real-device assertions while recovering transient emulator UI and
  // WebView debugger failures without making a pass out of an application error.
  assert.match(phase, /recoverEmulatorAnr/);
  assert.match(phase, /"forward", "tcp:0", target/);
  assert.match(phase, /"forward", "--remove", `tcp:\$\{port\}`/);
  assert.match(phase, /--peer-connect-smoke/);
  assert.match(phase, /await openAndroidFolder\(cdp, false, false\)/);
  assert.match(phase, /Automatic discovery E2E must not use a fixed host/);
});
