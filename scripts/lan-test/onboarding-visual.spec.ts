import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { browser } from "@wdio/globals";
import type * as Tauri from "@tauri-apps/api";

const screenshotDir = process.env.SYNCPEER_ONBOARDING_SCREENSHOTS ??
  path.resolve(".screenshots", "onboarding");

const verifyDialog = async (step: string, keySelector: string, requireTop = true) => {
  const geometry = await browser.execute(selector => {
    const dialog = document.querySelector<HTMLElement>("[data-testid='personal-space-onboarding']");
    const heading = dialog?.querySelector<HTMLElement>(".dialog-heading");
    const key = dialog?.querySelector<HTMLElement>(selector);
    const area = dialog?.getBoundingClientRect();
    const title = heading?.getBoundingClientRect();
    const action = key?.getBoundingClientRect();
    const viewport = { width: innerWidth, height: innerHeight };
    const visible = (rect?: DOMRect) => Boolean(rect && rect.top >= 0 &&
      rect.bottom <= viewport.height && rect.left >= 0 && rect.right <= viewport.width);
    return { viewport, dialog: area?.toJSON(), heading: title?.toJSON(),
      action: action?.toJSON(), headingVisible: visible(title),
      actionVisible: visible(action), scrollTop: dialog?.scrollTop ?? -1,
      scrollHeight: dialog?.scrollHeight ?? -1, clientHeight: dialog?.clientHeight ?? -1 };
  }, keySelector);
  console.log(`Onboarding ${step} geometry: ${JSON.stringify(geometry)}`);
  await mkdir(screenshotDir, { recursive: true });
  await browser.execute(async () => {
    const tauri = (window as typeof window & { __TAURI__: typeof Tauri }).__TAURI__;
    await tauri.window.getCurrentWindow().setFocus();
  });
  await browser.waitUntil(() => browser.execute(() => document.hasFocus()), { timeout: 5000 });
  // Hide ephemeral recovery/private data from the screenshot only.
  await browser.execute(() => {
    const style = document.createElement("style");
    style.id = "onboarding-screenshot-redaction";
    style.textContent = "[data-testid='onboarding-recovery-phrase'], [data-testid='onboarding-kit-json'] { color: transparent !important; }";
    document.head.append(style);
  });
  try {
    const result = spawnSync("scrot", ["-o", "-u", path.join(screenshotDir, `${step}.png`)]);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${step}: native screenshot failed`);
  } finally {
    await browser.execute(() => document.querySelector("#onboarding-screenshot-redaction")?.remove());
  }
  if (requireTop) {
    assert.ok(geometry.headingVisible, `${step}: heading must be in the viewport`);
    assert.ok(geometry.scrollTop <= 2, `${step}: dialog must start at its heading`);
  }
  assert.ok(geometry.scrollHeight <= geometry.clientHeight + 2,
    `${step}: onboarding should fit without scrolling at this viewport`);
  assert.ok(geometry.actionVisible, `${step}: primary field must be in the viewport`);
  assert.ok(geometry.dialog && geometry.dialog.top >= 0 &&
    geometry.dialog.bottom <= geometry.viewport.height,
    `${step}: dialog must fit the native window`);
};

const click = async (selector: string) => {
  const button = browser.$(selector);
  await button.waitForClickable();
  await button.click();
};

describe("Native Tauri onboarding visual acceptance", () => {
  it("completes each dialog with visible heading and fields", async () => {
    if (process.env.SYNCPEER_ONBOARDING_LARGE_WINDOW === "1") {
      await browser.execute(async () => {
        const tauri = (window as typeof window & { __TAURI__: typeof Tauri }).__TAURI__;
        await tauri.window.getCurrentWindow().setSize(new tauri.dpi.LogicalSize(1000, 880));
      });
      await browser.waitUntil(async () => browser.execute(() => innerWidth >= 900 && innerHeight >= 800),
        { timeout: 5000, timeoutMsg: "The native Tauri window did not resize to the large test viewport." });
    }
    await browser.$("[data-testid='personal-space-onboarding']")
      .waitForExist({ timeout: 30_000 });
    await verifyDialog("01-initial", "[data-testid='onboarding-generate-password']");
    await click("[data-testid='onboarding-generate-password']");
    await browser.waitUntil(async () =>
      (await browser.$("[data-testid='onboarding-master-password']").getValue()).length === 43,
      { timeout: 10_000 });
    await verifyDialog("02-generated-password", "[data-testid='onboarding-master-password']");
    await click("[data-testid='onboarding-continue']");
    await verifyDialog("03-confirm-master", "[data-testid='onboarding-confirm-password']");
    await click("[data-testid='onboarding-confirm-password']");
    await verifyDialog("04-recovery-step", "[data-testid='onboarding-generate-kit']");
    await click("button=Back");
    await verifyDialog("05-return-to-master-confirm", "[data-testid='onboarding-confirm-password']");
    await click("[data-testid='onboarding-confirm-password']");
    await verifyDialog("06-return-to-recovery", "[data-testid='onboarding-generate-kit']");
    await click("[data-testid='onboarding-generate-kit']");
    await browser.$("a[download='syncpeer-offline-signing-kit.json']")
      .waitForExist({ timeout: 60_000 });
    await verifyDialog("07-recovery-generated", "[data-testid='onboarding-recovery-phrase']");
    await click("[data-testid='onboarding-kit-confirm']");
    await verifyDialog("08-ready-to-create", "[data-testid='onboarding-create']");
    await click("[data-testid='onboarding-create']");
    await browser.$("[data-testid='personal-space-onboarding']")
      .waitForExist({ reverse: true, timeout: 60_000 });
    const result = spawnSync("scrot", ["-o", "-u", path.join(screenshotDir, "09-created.png")]);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, "Created personal space screenshot failed");
    console.log("Onboarding complete: first-run dialog closed successfully.");
  });
});
