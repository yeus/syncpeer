// One real-input test for desktop Tauri WebDriver and Android Appium WebView.
// Do not replace click() with execute(DOM click): that bypasses input dispatch.
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";

describe("Shared Tauri first-run onboarding", () => {
  it("generates a password, skips onboarding and opens Devices", async () => {
    const dialog = browser.$("[data-testid='personal-space-onboarding']");
    await dialog.waitForDisplayed({ timeout: 60_000 });

    const generate = browser.$("[data-testid='onboarding-generate-password']");
    await generate.waitForClickable({ timeout: 20_000 });
    await generate.click();
    await browser.waitUntil(async () => browser.execute(() =>
      (document.querySelector<HTMLInputElement>("[data-testid='onboarding-master-password']")
        ?.value.length ?? 0) === 43), {
      timeout: 20_000,
      timeoutMsg: "Real UI click did not generate a password.",
    });
    // The WebView WebDriver click above is shared. On Android also inject a
    // genuine UiAutomator2 touch at the same element in native screen pixels.
    // The dedicated fixture has no user credentials; never print password values.
    if (browser.capabilities.platformName === "Android") {
      const input = browser.$("[data-testid='onboarding-master-password']");
      await input.setValue("synthetic-temporary-android-input");
      await browser.waitUntil(async () => browser.execute(() =>
        document.querySelector<HTMLInputElement>(
          "[data-testid='onboarding-master-password']")?.value.length === 33), {
        timeout: 10_000,
      });
      const rect = await browser.execute("mobile: viewportElementRect", {
        elementId: (await generate).elementId,
      }) as { x: number; y: number; width: number; height: number };
      const context = await browser.getContext();
      if (typeof context !== "string" || !context.startsWith("WEBVIEW_")) {
        throw new Error("Native pointer test requires an attached application WebView.");
      }
      await browser.switchContext("NATIVE_APP");
      try {
        await browser.execute("mobile: clickGesture", {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        });
      } finally {
        await browser.switchContext(context);
      }
      await browser.waitUntil(async () => browser.execute(() =>
        (document.querySelector<HTMLInputElement>(
          "[data-testid='onboarding-master-password']")?.value.length ?? 0) === 43), {
        timeout: 20_000, timeoutMsg: "Native Android touch did not regenerate the password.",
      });
    }
    // Do not log the generated secret.
    const skip = browser.$("[data-testid='onboarding-skip']");
    await skip.waitForClickable({ timeout: 20_000 });
    await skip.click();
    await dialog.waitForExist({ reverse: true, timeout: 20_000 });

    const devices = browser.$("[data-testid='tab-devices']");
    await devices.waitForClickable({ timeout: 20_000 });
    await devices.click();
    await browser.waitUntil(async () => (await devices.getAttribute("class"))?.includes("active") === true, {
      timeout: 20_000,
      timeoutMsg: "Devices tab did not respond to real UI click.",
    });
    assert.ok(await devices.isDisplayed());
  });
  it("resumes setup, generates recovery keys and creates an encrypted personal space", async () => {
    const resume = browser.$("[data-testid='resume-personal-space-setup']");
    await resume.waitForClickable({ timeout: 20_000 });
    await resume.click();
    const dialog = browser.$("[data-testid='personal-space-onboarding']");
    await dialog.waitForDisplayed({ timeout: 20_000 });

    const generate = browser.$("[data-testid='onboarding-generate-password']");
    await generate.waitForClickable({ timeout: 20_000 });
    await generate.click();
    try {
      await browser.waitUntil(async () => browser.execute(() =>
        (document.querySelector<HTMLInputElement>("[data-testid='onboarding-master-password']")
          ?.value.length ?? 0) === 43), {
        timeout: 20_000, timeoutMsg: "Password generation failed after resuming setup.",
      });
    } catch (cause) {
      // Diagnose input delivery without exposing the generated secret.
      const state = await browser.execute(() => ({
        heading: document.querySelector("[data-testid='personal-space-onboarding'] h2")?.textContent?.trim(),
        passwordLength: document.querySelector<HTMLInputElement>(
          "[data-testid='onboarding-master-password']")?.value.length ?? -1,
        buttonDisabled: document.querySelector<HTMLButtonElement>(
          "[data-testid='onboarding-generate-password']")?.disabled ?? null,
        traceAction: document.querySelector("[data-testid='onboarding-trace-action']")?.textContent?.trim(),
        traceTarget: document.querySelector("[data-testid='onboarding-trace-target']")?.textContent?.trim(),
        traceEvents: document.querySelector("[data-testid='onboarding-trace-events']")?.textContent?.trim(),
        errors: Array.from(document.querySelectorAll("[role='alert']"))
          .map(value => value.textContent?.slice(0, 150)),
      })).catch(() => ({ probeUnavailable: true }));
      throw new Error("Resumed password generation failed: " + JSON.stringify(state), { cause });
    }


    const next = browser.$("[data-testid='onboarding-continue']");
    await next.waitForClickable({ timeout: 20_000 });
    await next.click();
    const confirm = browser.$("[data-testid='onboarding-confirm-password']");
    await confirm.waitForClickable({ timeout: 20_000 });
    await confirm.click();

    const recovery = browser.$("[data-testid='onboarding-generate-kit']");
    await recovery.waitForClickable({ timeout: 20_000 });
    await recovery.click();
    await browser.$("[data-testid='onboarding-kit-download']").waitForExist({ timeout: 120_000 });
    // Validate shape only. Neither mnemonic, kit data nor password may appear in test logs.
    const validKit = await browser.execute(() => {
      const phrase = document.querySelectorAll("[data-testid='onboarding-recovery-phrase'] span");
      const raw = document.querySelector<HTMLTextAreaElement>("[data-testid='onboarding-kit-json']")?.value;
      if (phrase.length !== 12 || !raw) return false;
      const kit = JSON.parse(raw) as { publicKey?: unknown };
      return typeof kit.publicKey === "string" && kit.publicKey.length > 0;
    });
    assert.equal(validKit, true, "A 12-word recovery phrase and valid encrypted kit must be generated.");
    const acknowledged = browser.$("[data-testid='onboarding-kit-confirm']");
    await acknowledged.waitForClickable({ timeout: 20_000 });
    await acknowledged.click();

    const create = browser.$("[data-testid='onboarding-create']");
    await create.waitForClickable({ timeout: 20_000 });
    await create.click();
    await dialog.waitForExist({ reverse: true, timeout: 120_000 });
    assert.equal(await browser.$("[data-testid='setup-skipped-notice']").isExisting(), false);
  });

  it("creates an encrypted folder through the actual UI", async () => {
    const folders = browser.$("[data-testid='tab-folders']");
    await folders.waitForClickable({ timeout: 30_000 });
    await folders.click();
    const add = browser.$("[data-testid='new-folder']");
    await add.waitForClickable({ timeout: 30_000 });
    await add.click();
    const page = browser.$("[data-testid='new-folder-page']");
    await page.waitForDisplayed({ timeout: 20_000 });
    await browser.$("//label[contains(., 'New folder name')]/input")
      .setValue("Synthetic UI acceptance folder");
    const create = browser.$("button=Create folder");
    await create.waitForClickable({ timeout: 20_000 });
    await create.click();
    await page.waitForExist({ reverse: true, timeout: 60_000 });
    await browser.waitUntil(async () => browser.execute(() =>
      Array.from(document.querySelectorAll("[data-testid^='folder-root-']"))
        .some(item => item.textContent?.includes("Synthetic UI acceptance folder"))), {
      timeout: 60_000, interval: 500,
      timeoutMsg: "The newly created encrypted folder never appeared in the root listing.",
    });
  });
});
