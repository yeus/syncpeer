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

  await click("[data-testid='onboarding-fixture']");
  await waitFor("[data-testid='personal-space-onboarding']");
  assert.equal(await browser.$("[data-testid='onboarding-device-name']").isExisting(), true);
  await click("[data-testid='onboarding-generate-password']");
  const generatedPassword = await browser.$("[data-testid='generated-master-password']");
  await generatedPassword.waitForExist();
  const generatedText = await generatedPassword.getText();
  assert.match(generatedText, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await browser.$("[data-testid='onboarding-master-password']").getValue(), generatedText);
  await click("[data-testid='onboarding-generated-saved']");
  await click("[data-testid='onboarding-continue']");
  await waitFor("[data-testid='onboarding-create']");
  console.log("Passed: first-run onboarding generates a visible master password and reaches the create step.");
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
  const html = `<html><body><script>
    window.addEventListener('error', event => { document.body.dataset.testError = event.message; });
    window.addEventListener('unhandledrejection', event => { document.body.dataset.testError = String(event.reason); });
    </script><script type="module" src="/${entry}"></script></body></html>`;
  const server = createHttpServer((request, response) => {
    const file = request.url === "/" ? html : files.get(request.url.slice(1));
    response.statusCode = file === undefined ? 404 : 200;
    response.setHeader("Content-Type", request.url === "/" ? "text/html" : "application/javascript");
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
