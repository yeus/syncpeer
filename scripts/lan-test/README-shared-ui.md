# Shared desktop/Android WebdriverIO acceptance

The **same** `shared-onboarding.spec.ts` runs against desktop Tauri WebDriver and Android Appium/UiAutomator2 + ChromeDriver. Assertions and real element clicks are shared. Only capabilities, lifecycle, and Android's initial WebView context selection differ. A `browser.execute(() => button.click())` test would NOT reproduce touch/pointer dispatch failures.

## Desktop

Enter the project Nix development shell (includes Xvfb, Openbox and WebKitWebDriver). Build the **LAN E2E debug** target, which injects the required Tauri WebDriver plugin, then run from `syncpeer/`:

```sh
npm run build:lan -w @syncpeer/tauri-shell
npm run test:ui:desktop
```

The runner isolates the **entire** WebDriver child tree with the existing private XDG and D-Bus/Secret Service helper. The existing **external** Tauri WebDriver launches the binary directly. Override the executable with `SYNCPEER_UI_DESKTOP_BINARY=/absolute/path` if needed. Do not use an ordinary non-E2E Tauri build, which does not load the WebdriverIO plugin. The shared acceptance scenario creates synthetic disposable credentials and a real encrypted local folder.

## Paired desktop + Android integration

The packaged pairing spec verifies invitation/approval, Android incoming ports, folder credentials and relay synchronization. It uses the isolated desktop runner without starting the unrelated Syncthing LAN coordinator. Run `SYNCPEER_ANDROID_SERIAL=emulator-5554 npm run test:ui:crossapp` after rebuilding both E2E packages. Use only the disposable `syncpeer-unified-e2e` AVD. **Latest complete run (2026-10-23/24): 3/3 passed in 7m 17s.** Desktop enrollment and desktop-to-Android authenticated signed credential propagation pass. The reverse Android-to-desktop relay test verifies the signed credential is materialized into the desktop document owner (`signedCredential: true`, `registered: true`, `conflictCount: 0`), attaches encrypted local storage (`downloads` transitions from false to true), then verifies the Android-authored file bytes on the packaged desktop. Root causes of the earlier red result were in the test: it searched for a root-list `<li>` after navigating to the folder-settings page, and it invoked the Android-only `syncpeer_document_command` on desktop for diagnostics. The corrected test uses the real settings page, and an E2E-only sanitized probe through the portable document owner. A separate intermittent initial onboarding create failure was observed in an earlier full run; targeted enrollment and the latest full run both passed. One packaged gate passing does not certify the entire 0.6.1 release. E2E diagnostics omit passwords, mnemonic and kit material.

## Android

Start a **disposable emulator** (e.g. `npm run android:emulator:modern`) on the host with KVM. Build/install the debug E2E APK using `npm run build:android:e2e` and `npm run android:install:e2e` in the Nix shell. Do NOT uninstall/clear data from an existing personal device. Use a fresh emulator instance that has never created a personal space.

Provision Appium 3 and its UiAutomator2 driver **outside this repository** so installing Appium does not replace project-locked Node dependencies (doing that previously downgraded `@types/node` and broke core builds):

```sh
npm install --prefix "$HOME/.local/share/syncpeer-appium" appium@3.8.0
"$HOME/.local/share/syncpeer-appium/node_modules/.bin/appium" driver install uiautomator2
"$HOME/.local/share/syncpeer-appium/node_modules/.bin/appium" server
```

The API-36 Google Play emulator used in the verified run shipped Android System WebView **133.0.6943**, which requires matching ChromeDriver 133. The verified binary was **133.0.6943.141** from Chrome for Testing. Check your emulator's actual WebView version (it can update separately) and supply a matching binary using `SYNCPEER_UI_CHROMEDRIVER=/absolute/path/to/chromedriver`. Do not disable version checking or accept arbitrary Chromedriver downloads inside the test.

```sh
export ANDROID_SERIAL=emulator-5554
npm run test:ui:android
```

For repeatable first-run acceptance on the **dedicated** `syncpeer-unified-e2e` AVD only, use `npm run test:ui:android:fresh`. This deliberately clears `dev.syncpeer.app` data, but first verifies the emulator serial, Android QEMU property, installed package, and exact AVD name. Ordinary `test:ui:android` never resets data. Never target a real device or a reused personal emulator.

The Android test runs a read-only preflight: online QEMU emulator, installed Syncpeer package, Appium /status. It refuses physical devices. Appium attaches with `noReset` and selects the Android WebView. The expanded shared spec uses real WebDriver clicks, and the Android native-pointer check additionally uses UiAutomator2 to press Generate Password and verifies its effect. Neither test proves release-signed install or physical-device performance. Native SAF pickers and lifecycle checks still need separate instrumentation.

## Focused host regressions (passing)

```sh
node --import tsx --test \
  scripts/test-directory-side-effects.ts \
  scripts/test-owned-devices-cache.ts
```

These focused host tests pass **14/14** after fixing browse-only snapshot persistence. They additionally guard Android session-configuration invalidation: read-only commands and failed mutations do not invalidate sessions, while successful `register` (publishes credentials) and `attachDownloads` (changes advertised folder set) still do. Blindly suppressing those latter invalidations would be a sharing-security regression.

Next device-level regression: create two disposable, owned synthetic peers with the existing LAN coordinator; open a browse-only folder, star several image fixtures while a transfer is active, and assert no `refresh_overview.failed`, no `saveDirectorySnapshot` error, and no unexpected `client.session.open.ready` followed by `tls_close`. Add restart/unlock and screen-off recovery as platform-specific lifecycle actions around shared UI assertions. Never reuse real peer IDs, passwords, or addresses from logs.

**Status (2026-10-23/24):** Shared first-run suite **3/3 desktop and 3/3 Android**, including the Android native-touch Generate Password regression. Disposable API-36 `syncpeer-unified-e2e` emulator uses Appium 3.8.0, UiAutomator2 8.7.0, ChromeDriver 133. Packaged cross-app pairing passes 3/3: configured Android listener, desktop-created credential propagation, and Android-created folder credential replication over relay with encrypted attachment and file-content verification. ESLint and TypeScript checks pass. Do not gate a release as green while native lifecycle, full transfer-under-load, and physical-device/release-signed acceptance remain unverified.
