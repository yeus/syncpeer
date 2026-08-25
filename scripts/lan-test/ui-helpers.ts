import { createHash } from "node:crypto";
import { $ } from "@wdio/globals";
import type { Browser as WdioBrowser } from "webdriverio";
import type { BrowserExtension } from "@wdio/native-types";

export type TauriBrowser = WdioBrowser & BrowserExtension;

export const waitForText = async (
  browser: TauriBrowser,
  text: string,
  timeout = 60_000,
): Promise<void> => {
  await browser.waitUntil(
    async () => (await browser.getPageSource()).includes(text),
    { timeout, timeoutMsg: "Timed out waiting for text: " + text },
  );
};

export const setValue = async (testId: string, value: string): Promise<void> => {
  const element = $("[data-testid='" + testId + "']");
  await element.click();
  await element.setValue(value);
};

export const setUploadFile = async (
  browser: TauriBrowser,
  filePath: string,
): Promise<void> => {
  await browser.execute(() => {
    const input = document.getElementById("folder-upload-input") as HTMLElement | null;
    if (!input) throw new Error("The folder upload input is not mounted.");
    input.style.display = "block";
  });
  await $("#folder-upload-input").setValue(filePath);
};

export const connectUntilApproved = async (
  browser: TauriBrowser,
  timeout = 10 * 60_000,
): Promise<void> => {
  const button = $("[data-testid='global-connect-button']");
  const deadline = Date.now() + timeout;
  let lastState = "";
  let lastError = "";
  while (Date.now() < deadline) {
    const label = (await button.getText()).trim();
    const state = label + "/enabled=" + (await button.isEnabled());
    if (state !== lastState) {
      console.log("UI connect state: " + state);
      lastState = state;
    }
    if (label === "Disconnect") return;
    if (label === "Connect" && await button.isEnabled()) {
      await button.click();
      const error = $("p.error");
      if (await error.isExisting()) {
        lastError = await error.getText();
        console.log("UI connection attempt failed; retrying: " + lastError);
      }
    }
    await browser.pause(2_000);
  }
  const suffix = lastError ? " Last error: " + lastError : "";
  throw new Error("Timed out waiting for the server to approve this client." + suffix);
};

export const waitForDisconnected = async (
  browser: TauriBrowser,
  timeout = 30_000,
): Promise<void> => {
  const button = $("[data-testid='global-connect-button']");
  await browser.waitUntil(
    async () => (await button.getText()).trim() === "Connect",
    { timeout, timeoutMsg: "Timed out waiting for the UI to disconnect." },
  );
};

export const readCachedHash = async (
  browser: TauriBrowser,
  relativePath: string,
): Promise<string | null> => {
  const records = await browser.tauri.execute((tauri) =>
    tauri.core.invoke("syncpeer_list_cached_files"),
  ) as Array<{ path: string; localPath?: string }>;
  const record = records.find((candidate) => candidate.path === relativePath);
  if (!record?.localPath) return null;
  const bytes = await browser.tauri.execute((tauri, filePath: string) =>
    tauri.core.invoke("syncpeer_read_binary_file", { request: { path: filePath } }),
    record.localPath,
  ) as number[];
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
};
