import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "vite";
import { createServer as createHttpServer } from "node:http";
import { remote } from "webdriverio";

async function unusedPort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForDriver(port, driver) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (driver.exitCode !== null) throw new Error("WebKitWebDriver exited before startup.");
    if (await fetch(`http://127.0.0.1:${port}/status`).then(response => response.ok).catch(() => false)) return;
    await delay(100);
  }
  throw new Error("WebKitWebDriver did not start. Run this test with an X display or xvfb-run.");
}

async function runSettingsUiTest(browser) {
  const click = async selector => browser.execute(value => document.querySelector(value)?.click(), selector);
  const clickText = async label => browser.execute(value => {
    const button = [...document.querySelectorAll("button")].find(element => element.textContent.trim() === value);
    if (!button || button.disabled) throw new Error(`Button is unavailable: ${value}`);
    button.click();
  }, label);
  const waitFor = selector => browser.waitUntil(async () => {
    const error = await browser.execute(() => document.body.dataset.testError);
    if (error) throw new Error(`Settings fixture failed: ${error}`);
    return browser.$(selector).isExisting();
  }, { timeout: 15_000, timeoutMsg: `Settings fixture did not render ${selector}.` });
  const text = () => browser.$("body").getText();
  const calls = async () => JSON.parse(await browser.$("[data-testid='calls']").getHTML(false));
  const back = async () => {
    await click("[data-testid$='settings-page'] > button, [data-testid='new-folder-page'] > button");
    await waitFor("[data-testid='folder-settings-photos']");
  };

  await waitFor("[data-testid='folder-settings-photos']");
  await waitFor("[data-testid='device-name-prompt']");
  assert.equal(await browser.$("[data-testid='device-name-onboarding']").isExisting(), false);
  assert.equal(await browser.$("[data-testid='personal-space-onboarding']").isExisting(), false);
  await browser.$("[data-testid='local-name-entry']").setValue("Synthetic Laptop");
  await click("[data-testid='save-local-device-name']");
  await browser.$("[data-testid='device-name-prompt']").waitForExist({ reverse: true });
  assert.match(await text(), /Advertised name: Synthetic Laptop/);
  await click("[data-testid='reset-local-name-fixture']");
  await waitFor("[data-testid='device-name-prompt']");
  await click("[data-testid='dismiss-local-name-prompt']");
  await browser.$("[data-testid='device-name-prompt']").waitForExist({ reverse: true });
  console.log("Passed: missing-name fallback is inline, saves a name, and can be dismissed without another onboarding modal.");
  await browser.execute(() => {
    const detail = [...document.querySelectorAll("summary")]
      .find(element => element.textContent.trim() === "This Device Details");
    detail?.click();
  });
  await clickText("Restore From Backup Secret");
  const backupSecret = browser.$("[data-testid='device-identity-backup-secret']");
  await backupSecret.waitForExist();
  await backupSecret.setValue("synthetic-identity-secret");
  assert.equal(await backupSecret.getAttribute("type"), "password");
  await click("[data-testid='device-identity-backup-secret-visibility']");
  assert.equal(await backupSecret.getAttribute("type"), "text");
  assert.equal(await backupSecret.getValue(), "synthetic-identity-secret");
  await click("[data-testid='device-identity-backup-secret-visibility']");
  assert.equal(await backupSecret.getAttribute("type"), "password");
  await clickText("Hide Restore");
  console.log("Passed: device identity backup secrets are hidden by default and revealable.");
  assert.equal(await browser.$("[data-testid='folder-password-photos']").isExisting(), false);
  assert.equal(await browser.$("[aria-label='Forget saved folder password']").isExisting(), false);
  await click("[data-testid='folder-settings-photos']");
  await waitFor("textarea");
  assert.equal(await browser.$("textarea").getValue(), "photos-only");
  assert.doesNotMatch(await text(), /documents-only|Personal-space backup|Change master password|Synchronization defaults|synthetic-never-rendered-credential/);
  await browser.$("textarea").setValue("photos-updated");
  await clickText("Save ignore patterns");
  await browser.waitUntil(async () => (await calls()).some(call => call.operation === "saveProfileSettings"));
  const folderSave = (await calls()).findLast(call => call.operation === "saveProfileSettings");
  assert.deepEqual(folderSave.settings.folders.photos.ignorePatterns, ["photos-updated"]);
  assert.deepEqual(folderSave.settings.folders.documents.ignorePatterns, ["documents-only"]);
  await browser.execute(() => {
    const input = [...document.querySelectorAll("label")]
      .find(label => label.textContent.includes("Minimum complete copies"))?.querySelector("input");
    input.value = "4";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await browser.waitUntil(async () => (await calls()).some(call => call.operation === "savePersonalSpaceSetting"));
  assert.deepEqual((await calls()).findLast(call => call.operation === "savePersonalSpaceSetting").path,
    ["folders", "photos", "retention"]);
  const folderSecret = browser.$("[data-testid='folder-password-photos']");
  assert.equal(await folderSecret.getAttribute("type"), "password");
  await click("[data-testid='folder-password-photos-visibility']");
  assert.equal(await folderSecret.getAttribute("type"), "text");
  assert.equal(await folderSecret.getValue(), "synthetic-folder-password");
  await click("[data-testid='folder-password-photos-visibility']");
  assert.equal(await folderSecret.getAttribute("type"), "password");
  await click("[data-testid='unlock-folder-photos']");
  assert.equal((await calls()).findLast(call => call.operation === "saveFolderPassword").folderId, "photos");
  await back();
  console.log("Passed: folder menu scopes passwords, policies and exclusions to the selected folder.");

  await click("[data-testid='connection-settings-toggle']");
  await click("[data-testid='general-settings']");
  await waitFor("[data-testid='device-settings'] select");
  assert.match(await text(), /Personal space/);
  assert.match(await text(), /Personal-space backup/);
  assert.match(await text(), /This device/);
  assert.doesNotMatch(await text(), /Ignored patterns|Whole-folder retention|Reattach encrypted local storage/);
  await browser.execute(() => {
    const select = document.querySelector("[data-testid='device-settings'] select");
    select.value = "simple";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await browser.waitUntil(async () => (await calls()).findLast(call => call.operation === "saveProfileSettings")
    ?.settings.profile.versioning === "simple");
  await clickText("Open settings for Documents");
  await waitFor("textarea");
  assert.equal(await browser.$("textarea").getValue(), "documents-only");
  assert.match(await text(), /documents-only-conflict/);
  assert.doesNotMatch(await text(), /photos-updated/);
  await back();
  console.log("Passed: personal-space controls and device defaults are reachable through general Settings.");

  await click("[data-testid='lock-fixture']");
  await click("[data-testid='folder-settings-photos']");
  await browser.$("button=Open general settings").waitForExist();
  assert.doesNotMatch(await text(), /Ignored patterns|Whole-folder retention/);
  await clickText("Open general settings");
  await browser.$("input[autocomplete='current-password']").waitForExist();
  await browser.$("input[autocomplete='current-password']").setValue("synthetic-local-master-password");
  await clickText("Unlock");
  await waitFor("[data-testid='device-settings'] select");
  assert.ok((await calls()).some(call => call.operation === "unlock"));
  await back();
  await click("[data-testid='new-folder']");
  await browser.$("input").waitForExist();
  await browser.$("input").setValue("Synthetic new folder");
  await clickText("Create folder");
  await waitFor("[data-testid='folder-settings-photos']");
  assert.equal((await calls()).findLast(call => call.operation === "createFolder").label, "Synthetic new folder");
  console.log("Passed: locked folder settings lead to space unlock; creation returns to the folder browser.");

  await click("[data-testid='uninitialized-fixture']");
  await click("[data-testid='new-folder']");
  await browser.$("button=Open general settings").waitForExist();
  await clickText("Open general settings");
  await browser.$("button=Create encrypted profile").waitForExist();
  assert.match(await text(), /Join an existing personal space/);
  assert.equal(await browser.$("button=Create folder").isExisting(), false);
  console.log("Passed: fresh-profile setup and joining live in personal-space settings.");
  await back();
  await click("[data-testid='browser-fixture']");
  const priorCalls = (await calls()).length;
  await click("[data-testid='folder-settings-photos']");
  await waitFor("[data-testid='folder-password-photos']");
  assert.equal((await calls()).length, priorCalls);
  assert.doesNotMatch(await text(), /Whole-folder retention|Move to plaintext|Open general settings/);
  await click("[data-testid='unlock-folder-photos']");
  assert.equal((await calls()).at(-1).operation, "saveFolderPassword");
  console.log("Passed: browser-only folder passwords work without accessing native storage.");

  await browser.setWindowSize(390, 680);
  await click("[data-testid='onboarding-fixture']");
  await waitFor("[data-testid='personal-space-onboarding']");
  await waitFor("[data-testid='onboarding-input-diagnostics']");
  await browser.waitUntil(async () =>
    (await browser.$("[data-testid='onboarding-trace-heartbeat']").getText()) !== "JS: 0s",
    { timeout: 4000, timeoutMsg: "Onboarding JavaScript heartbeat stopped." });
  const backdropStyle = await browser.execute(() => {
    const style = getComputedStyle(document.querySelector(".onboarding-backdrop"));
    return { blur: style.backdropFilter || style.webkitBackdropFilter, background: style.backgroundColor };
  });
  assert.match(backdropStyle.blur, /blur\(/, "The onboarding background should be blurred.");
  assert.match(backdropStyle.background, /15, 23, 42/, "The backdrop should dim rather than wash out the app.");
  assert.equal(await browser.$("[data-testid='onboarding-device-name']").isExisting(), true);
  await browser.waitUntil(async () =>
    Number(await browser.execute(() => document.querySelector("[data-testid='synthetic-biometric-status-checks']")?.textContent)) === 1,
    { timeout: 5000, timeoutMsg: "Biometric initialization was not invoked exactly once." });
  // Simulate an Android-style interrupted click propagation path: critical
  // controls must remain usable with direct element listeners.
  await browser.execute(() => {
    document.querySelector("[data-testid='personal-space-onboarding']")
      ?.addEventListener("click", event => event.stopPropagation());
  });
  await click("[data-testid='onboarding-skip']");
  await browser.$("[data-testid='personal-space-onboarding']")
    .waitForExist({ reverse: true });
  await waitFor("[data-testid='folder-settings-photos']");
  await click("[data-testid='onboarding-fixture']");
  await waitFor("[data-testid='personal-space-onboarding']");
  await browser.waitUntil(async () =>
    Number(await browser.execute(() => document.querySelector("[data-testid='synthetic-biometric-status-checks']")?.textContent)) === 2,
    { timeout: 5000, timeoutMsg: "Biometric initialization must run once per onboarding instance." });
  await browser.execute(() => {
    window.__stopOnboardingClicks = event => event.stopPropagation();
    document.querySelector("[data-testid='personal-space-onboarding']")
      ?.addEventListener("click", window.__stopOnboardingClicks);
  });
  await click("[data-testid='onboarding-copy-diagnostics']");
  await waitFor("[data-testid='synthetic-diagnostics-copied']");
  // Simulate an unavailable browser helper; this is not a confirmed Android root cause.
  // Master-password generation must still succeed without btoa.
  await browser.execute(() => {
    window.__savedBtoa = window.btoa;
    window.btoa = undefined;
  });
  await browser.$("[data-testid='onboarding-generate-password']").click();
  const masterPasswordInput = browser.$("[data-testid='onboarding-master-password']");
  await browser.waitUntil(async () => (await masterPasswordInput.getValue()).length === 43);
  assert.equal(await browser.$("[data-testid='generated-master-password']").isExisting(), false);
  assert.equal(await browser.$("[data-testid='onboarding-copy-password']").isExisting(), true);
  assert.match(await browser.$("[data-testid='onboarding-trace-events']").getText(), /Click: [1-9]/);
  assert.match(await browser.$("[data-testid='onboarding-trace-target']").getText(), /click on generate/);
  assert.equal(await browser.$("[data-testid='onboarding-trace-action']").getText(), "Last action: generate handler entered");
  // Touch pointer-up activates even if a WebView never emits a click.
  // A subsequent compatibility click must not generate a second password.
  await browser.execute(() => {
    const button = document.querySelector("[data-testid='onboarding-generate-password']");
    const options = { bubbles: true, pointerType: "touch", pointerId: 8, isPrimary: true, clientX: 10, clientY: 10 };
    button.dispatchEvent(new PointerEvent("pointerdown", options));
    button.dispatchEvent(new PointerEvent("pointerup", options));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await browser.waitUntil(async () => (await calls()).filter(call => call.operation === "generationEvent").length === 4);
  const generatedText = await masterPasswordInput.getValue();
  assert.deepEqual((await calls()).filter(call => call.operation === "generationEvent")
    .map(call => call.stage), ["requested", "generated", "requested", "generated"]);
  assert.match(generatedText, /^[A-Za-z0-9_-]{43}$/);
  const mobileLayout = await browser.execute(() => {
    const dialog = document.querySelector("[data-testid='personal-space-onboarding']");
    const password = document.querySelector("[data-testid='onboarding-master-password']");
    const rect = password?.getBoundingClientRect();
    return {
      width: dialog?.scrollWidth ?? 0,
      dialogWidth: dialog?.clientWidth ?? 0,
      viewport: window.innerWidth,
      passwordVisible: Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight),
      hasDialog: Boolean(dialog),
    };
  });
  assert.equal(mobileLayout.hasDialog, true);
  assert.ok(mobileLayout.width <= mobileLayout.dialogWidth + 2, `Onboarding dialog overflows narrow screens: ${JSON.stringify(mobileLayout)}`);
  assert.equal(mobileLayout.passwordVisible, true, "Master-password input must stay visible after generation.");
  await browser.execute(() => {
    const dialog = document.querySelector("[data-testid='personal-space-onboarding']");
    dialog.removeEventListener("click", window.__stopOnboardingClicks);
    delete window.__stopOnboardingClicks;
  });
  assert.equal(await masterPasswordInput.getValue(), generatedText);
  assert.equal(await masterPasswordInput.getAttribute("type"), "password");
  await browser.$("[data-testid='onboarding-master-password-visibility']").click();
  assert.equal(await masterPasswordInput.getAttribute("type"), "text");
  await browser.$("[data-testid='onboarding-master-password-visibility']").click();
  assert.equal(await masterPasswordInput.getAttribute("type"), "password");
  await browser.execute(() => {
    window.btoa = window.__savedBtoa;
    delete window.__savedBtoa;
  });
  assert.equal(await browser.$("[data-testid='onboarding-generated-saved']").isExisting(), false);
  await browser.execute(() => {
    window.__savedRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    HTMLFormElement.prototype.requestSubmit = undefined;
  });
  await click("[data-testid='onboarding-continue']");
  await waitFor("[data-testid='onboarding-confirm-password']");
  await click("[data-testid='onboarding-confirm-password']");
  await waitFor("[data-testid='onboarding-create']");
  const recoveryPosition = await browser.execute(() => {
    const dialog = document.querySelector("[data-testid='personal-space-onboarding']");
    const heading = dialog.querySelector(".dialog-heading").getBoundingClientRect();
    return { scrollTop: dialog.scrollTop, headingTop: heading.top, headingBottom: heading.bottom };
  });
  assert.equal(recoveryPosition.scrollTop, 0, "A new onboarding step starts at its heading.");
  assert.ok(recoveryPosition.headingTop >= 0 && recoveryPosition.headingBottom <= 680,
    `Recovery heading must remain visible: ${JSON.stringify(recoveryPosition)}`);
  await browser.execute(() => {
    HTMLFormElement.prototype.requestSubmit = window.__savedRequestSubmit;
    delete window.__savedRequestSubmit;
  });
  assert.equal(await browser.$("[data-testid='onboarding-create']").isEnabled(), true);
  await click("[data-testid='onboarding-create']");
  assert.match(await browser.$("[role='alert']").getText(), /generate.*recovery/i);
  await click("[data-testid='onboarding-generate-kit']");
  await browser.$("a[download='syncpeer-offline-signing-kit.json']")
    .waitForExist({ timeout: 60000 });
  assert.equal(await browser.execute(() =>
    document.querySelectorAll("[data-testid='onboarding-recovery-phrase'] span").length), 12);
  await click("[data-testid='onboarding-create']");
  assert.match(await browser.$("[role='alert']").getText(), /confirm.*saved/i);
  await click("[data-testid='onboarding-kit-confirm']");
  await click("[data-testid='onboarding-create']");
  await waitFor("[data-testid='synthetic-first-peer-folder']");
  assert.equal((await calls()).filter(call => call.operation === "createVault").length, 1);
  assert.equal((await calls()).findLast(call => call.operation === "saveDeviceName")?.name, "synthetic-device");
  console.log("Passed: synthetic first-run flow reaches the first advertised peer folder; packaged tests cover real transport.");
  await click("[data-testid='break-generation-logger-fixture']");
  await click("[data-testid='onboarding-fixture']");
  await waitFor("[data-testid='personal-space-onboarding']");
  await browser.$("[data-testid='onboarding-generate-password']").click();
  const loggerFailedPassword = browser.$("[data-testid='onboarding-master-password']");
  await browser.waitUntil(async () => (await loggerFailedPassword.getValue()).length === 43);
  assert.match(await loggerFailedPassword.getValue(), /^[A-Za-z0-9_-]{43}$/);
  await click("[data-testid='onboarding-skip']");
  await browser.$("[data-testid='personal-space-onboarding']").waitForExist({ reverse: true });
  console.log("Passed: failed diagnostic logging cannot block password generation or skip.");
}

async function main() {
  const fixturePath = path.resolve("packages/app/tests/settings-fixture.svelte");
  const built = await build({ root: path.resolve("packages/app"),
    configFile: path.resolve("packages/app/vite.config.ts"), logLevel: "error",
    build: { write: false, minify: false, rollupOptions: { input: "settings-ui-entry" } },
    plugins: [{ name: "settings-ui-fixture",
      resolveId(id) { if (id === "settings-ui-entry") return "\0settings-ui-entry"; },
      load(id) {
        if (id === "\0settings-ui-entry") return `import { mount } from 'svelte';
          import Fixture from ${JSON.stringify(fixturePath)};
          mount(Fixture, { target: document.body });`;
      },
    }],
  });
  const files = new Map(built.output.map(file => [file.fileName, file.type === "chunk" ? file.code : file.source]));
  const entry = built.output.find(file => file.type === "chunk" && file.isEntry).fileName;
  const styles = built.output.filter(file => file.type === "asset" && file.fileName.endsWith(".css"));
  const html = `<html><head>${styles.map(file => `<link rel="stylesheet" href="/${file.fileName}">`).join("")}</head><body><script>
    window.addEventListener('error', event => { document.body.dataset.testError = event.message; });
    window.addEventListener('unhandledrejection', event => { document.body.dataset.testError = String(event.reason); });
    </script><script type="module" src="/${entry}"></script></body></html>`;
  const server = createHttpServer((request, response) => {
    const file = request.url === "/" ? html : files.get(request.url.slice(1));
    response.statusCode = file === undefined ? 404 : 200;
    response.setHeader("Content-Type", request.url === "/" ? "text/html" : request.url.endsWith(".css") ? "text/css" : "application/javascript");
    response.end(file ?? "Not found");
  });
  const port = await unusedPort();
  const driver = spawn("WebKitWebDriver", [`--port=${port}`], { stdio: "ignore" });
  driver.on("error", () => {});
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await waitForDriver(port, driver);
    browser = await remote({ hostname: "127.0.0.1", port, logLevel: "error",
      capabilities: { browserName: "MiniBrowser", "wdio:enforceWebDriverClassic": true } });
    await browser.url(`http://127.0.0.1:${server.address().port}/`);
    await runSettingsUiTest(browser);
  } finally {
    try { await browser?.deleteSession(); }
    finally {
      driver.kill();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

await main();
