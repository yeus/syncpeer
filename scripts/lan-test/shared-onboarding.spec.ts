// Real UI input shared by desktop Tauri WebDriver and Android Appium WebView.
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";

describe("Shared Tauri first-run onboarding", () => {
  it("shows only a full-screen device-name step and accepts a real click/touch", async () => {
    const onboarding = browser.$("[data-testid='device-name-onboarding']");
    await onboarding.waitForDisplayed({ timeout: 60_000 });
    const geometry = await browser.execute(() => {
      const area = document.querySelector<HTMLElement>("[data-testid='device-name-onboarding']")!
        .getBoundingClientRect();
      return { fullScreen: area.width >= innerWidth && area.height >= innerHeight,
        otherControls: Boolean(document.querySelector("[data-testid='tab-devices'], [data-testid='personal-space-onboarding'], [data-testid='general-settings-page']")) };
    });
    assert.equal(geometry.fullScreen, true);
    assert.equal(geometry.otherControls, false);

    await browser.$("[data-testid='local-name-entry']").setValue("Syncpeer acceptance device");
    const continueButton = browser.$("[data-testid='save-local-device-name']");
    await continueButton.waitForClickable({ timeout: 20_000 });
    if (browser.capabilities.platformName === "Android") {
      const rect = await browser.execute("mobile: viewportElementRect", {
        elementId: (await continueButton).elementId,
      }) as { x: number; y: number; width: number; height: number };
      const context = await browser.getContext();
      if (typeof context !== "string" || !context.startsWith("WEBVIEW_")) {
        throw new Error("A live Android WebView is required for the native-touch acceptance test.");
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
    } else {
      await continueButton.click();
    }
    await onboarding.waitForExist({ reverse: true, timeout: 20_000 });
    const devices = browser.$("[data-testid='tab-devices']");
    await devices.waitForDisplayed({ timeout: 20_000 });
    assert.equal((await devices.getAttribute("class"))?.includes("active"), true);
  });

  it("keeps Personal Space setup optional and accessible only through Settings", async () => {
    assert.equal(await browser.$("[data-testid='personal-space-onboarding']").isExisting(), false);
    const toggle = browser.$("[data-testid='connection-settings-toggle']");
    await toggle.waitForClickable({ timeout: 20_000 });
    await toggle.click();
    const open = browser.$("[data-testid='general-settings']");
    await open.waitForClickable({ timeout: 20_000 });
    await open.click();
    await browser.$("[data-testid='general-settings-page']").waitForDisplayed({ timeout: 20_000 });
    const optional = browser.$("[data-testid='optional-personal-space-setup']");
    await optional.waitForExist({ timeout: 20_000 });
    await optional.$("summary").click();
    assert.equal(await optional.$("form input[autocomplete='new-password']").isDisplayed(), true);
    await browser.$("[data-testid='general-settings-page'] > button").click();
    await browser.$("[data-testid='tab-devices']").waitForDisplayed({ timeout: 20_000 });
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
