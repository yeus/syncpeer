import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

export const clickItemTitle = async (
  browser: TauriBrowser,
  name: string,
): Promise<void> => {
  const clicked = await browser.execute((title: string) => {
    const item = [...document.querySelectorAll(".item-title")].find(
      (element) => element.textContent?.trim() === title,
    );
    const target = item?.closest(".item-main-hit-clickable") as HTMLElement | null;
    if (!target) return false;
    target.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    return true;
  }, name);
  if (!clicked) throw new Error("Could not click folder item " + name + ".");
};

export const clickDownloadButton = async (
  browser: TauriBrowser,
  name: string,
): Promise<void> => {
  const clicked = await browser.execute((title: string) => {
    const item = [...document.querySelectorAll(".item-title")].find(
      (element) => element.textContent?.trim() === title,
    );
    const row = item?.closest("li");
    const button = row?.querySelector("button[aria-label^='Download']") as HTMLElement | null;
    if (!button) return false;
    button.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    return true;
  }, name);
  if (!clicked) throw new Error("Could not click Download for " + name + ".");
};

export const selectDiscoveryMode = async (
  browser: TauriBrowser,
  mode: "direct" | "lan" | "global",
): Promise<void> => {
  const selector = "[data-testid='connection-discovery-mode']";
  await browser.waitUntil(
    async () => (await browser.$(selector).isExisting()),
    { timeout: 5_000, timeoutMsg: "Connection mode selector is not mounted." },
  );
  await browser.execute((nextMode: string) => {
    const select = document.querySelector(
      "[data-testid='connection-discovery-mode']",
    ) as HTMLSelectElement | null;
    if (!select) throw new Error("Connection mode selector is not mounted.");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(select, nextMode);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, mode);
  await browser.waitUntil(
    async () => (await browser.$(selector).getValue()) === mode,
    { timeout: 5_000, timeoutMsg: "Connection mode did not update to " + mode + "." },
  );
};

export const setUploadFile = async (
  browser: TauriBrowser,
  filePath: string,
): Promise<void> => {
  const file = {
    name: path.basename(filePath),
    bytes: Array.from(fs.readFileSync(filePath)),
  };
  await browser.execute((payload: { name: string; bytes: number[] }) => {
    const input = document.getElementById("folder-upload-input") as HTMLInputElement | null;
    if (!input) throw new Error("The folder upload input is not mounted.");
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(payload.bytes)], payload.name));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, file);
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

export const readSessionEventNames = async (
  browser: TauriBrowser,
): Promise<string[]> => {
  await $("[data-testid='tab-devices']").click();
  const events = await browser.execute(() =>
    [...document.querySelectorAll(".item-meta")]
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => text.includes(" | "))
      .map((text) => text.split(" | ").at(-1) ?? "")
      .filter(Boolean)
      .slice(0, 80),
  );
  await $("[data-testid='tab-folders']").click();
  return events;
};
