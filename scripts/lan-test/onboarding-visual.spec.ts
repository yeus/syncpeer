import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { browser } from "@wdio/globals";
import type * as Tauri from "@tauri-apps/api";

const screenshotDir = process.env.SYNCPEER_ONBOARDING_SCREENSHOTS ??
  path.resolve(".screenshots", "onboarding");

const snapshot = async (file: string) => {
  await mkdir(screenshotDir, { recursive: true });
  await browser.execute(async () => {
    const tauri = (window as typeof window & { __TAURI__: typeof Tauri }).__TAURI__;
    await tauri.window.getCurrentWindow().setFocus();
  });
  const result = spawnSync("scrot", ["-o", "-u", path.join(screenshotDir, file)]);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "Native screenshot failed");
};

describe("Native Tauri first-run name-only visual acceptance", () => {
  it("shows a full-viewport name form without navigation or Personal Space setup", async () => {
    if (process.env.SYNCPEER_ONBOARDING_LARGE_WINDOW === "1") {
      await browser.execute(async () => {
        const tauri = (window as typeof window & { __TAURI__: typeof Tauri }).__TAURI__;
        await tauri.window.getCurrentWindow().setSize(new tauri.dpi.LogicalSize(1000, 880));
      });
      await browser.waitUntil(async () => browser.execute(() => innerWidth >= 900 && innerHeight >= 800),
        { timeout: 5000 });
    }

    const screen = browser.$("[data-testid='device-name-onboarding']");
    await screen.waitForDisplayed({ timeout: 30_000 });
    const geometry = await browser.execute(() => {
      const screen = document.querySelector<HTMLElement>("[data-testid='device-name-onboarding']")!;
      const rect = screen.getBoundingClientRect();
      const input = screen.querySelector<HTMLInputElement>("[data-testid='local-name-entry']")!
        .getBoundingClientRect();
      const button = screen.querySelector<HTMLButtonElement>("[data-testid='save-local-device-name']")!
        .getBoundingClientRect();
      return {
        width: innerWidth, height: innerHeight,
        fullScreen: rect.width >= innerWidth && rect.height >= innerHeight,
        inputVisible: input.top >= 0 && input.bottom <= innerHeight &&
          input.left >= 0 && input.right <= innerWidth,
        buttonVisible: button.top >= 0 && button.bottom <= innerHeight,
        hasTabs: Boolean(document.querySelector(".bottom-tabs, [data-testid='tab-devices']")),
        hasSpace: Boolean(document.querySelector("[data-testid='personal-space-onboarding']")),
      };
    });
    assert.equal(geometry.fullScreen, true, JSON.stringify(geometry));
    assert.equal(geometry.inputVisible, true, JSON.stringify(geometry));
    assert.equal(geometry.buttonVisible, true, JSON.stringify(geometry));
    assert.equal(geometry.hasTabs, false);
    assert.equal(geometry.hasSpace, false);
    await snapshot("01-name-only.png");

    await browser.$("[data-testid='local-name-entry']").setValue("Visual test device");
    await browser.$("[data-testid='save-local-device-name']").click();
    await screen.waitForExist({ reverse: true, timeout: 20_000 });
    await browser.$("[data-testid='tab-devices']").waitForDisplayed({ timeout: 20_000 });
    await snapshot("02-after-name.png");
  });
});
