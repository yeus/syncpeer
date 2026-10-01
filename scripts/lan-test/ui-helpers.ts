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

/** Exercise a button handler without WebKitWebDriver's offscreen coordinate click. */
export const clickButtonByText = async (
  browser: WebdriverIO.Browser,
  label: string,
): Promise<void> => {
  const state = await browser.execute((text: string) => {
    const button = [...document.querySelectorAll("button")]
      .find(element => element.textContent?.trim() === text);
    if (!(button instanceof HTMLButtonElement)) return "missing";
    if (button.disabled) return "disabled";
    button.click();
    return "clicked";
  }, label);
  if (state !== "clicked") throw new Error(`Button ${label} is ${state}.`);
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
  browser: WebdriverIO.Browser,
  mode: "automatic" | "direct" | "lan" | "global",
): Promise<void> => {
  const selector = "[data-testid='connection-discovery-mode']";
  await browser.waitUntil(
    async () => await browser.$(selector).isExisting(),
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

export const setDirectConnectionFields = async (browser: WebdriverIO.Browser, settings: {
  remoteId: string; host: string; remotePort: number; listenPort: number;
}): Promise<void> => {
  await selectDiscoveryMode(browser, "direct");
  await browser.execute(({ remoteId, host, remotePort, listenPort }) => {
    for (const [testId, value] of [
      ["connection-remote-id", remoteId],
      ["connection-host", host],
      ["connection-port", String(remotePort)],
      ["connection-listen-port", String(listenPort)],
    ]) {
      const field = document.querySelector(`[data-testid='${testId}']`) as HTMLInputElement | null;
      if (!field) throw new Error(`Connection field ${testId} is unavailable.`);
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, settings);
  await browser.waitUntil(async () => await browser.$("[data-testid='connection-port']").getValue() ===
    String(settings.remotePort), { timeout: 5_000, timeoutMsg: "Direct connection settings did not update." });
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
  const status = $("[data-testid='connection-status']");
  const deadline = Date.now() + timeout;
  let lastState = "";
  let lastError = "";
  while (Date.now() < deadline) {
    const label = (await status.getText()).trim();
    if (label !== lastState) {
      console.log("UI connect state: " + label);
      lastState = label;
    }
    if (label === "Connected") return;
    const error = $("p.error");
    if (await error.isExisting()) {
      lastError = await error.getText();
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
  const status = $("[data-testid='connection-status-toggle']");
  await browser.waitUntil(
    async () => await status.getAttribute("data-phase") === "idle",
    { timeout, timeoutMsg: "Timed out waiting for the UI to disconnect." },
  );
};

export const setAutomaticConnectionPaused = async (
  browser: TauriBrowser,
  paused: boolean,
): Promise<void> => {
  await $("[data-testid='tab-devices']").click();
  const settings = $("[data-testid='connection-settings-toggle']");
  if (await settings.getAttribute("aria-expanded") !== "true") await settings.click();
  const expert = $("[data-testid='expert-view']");
  if (!(await expert.isSelected())) await expert.click();
  const disclosure = $("[data-testid='connection-status-toggle']");
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const control = $("[data-testid='expert-connection-control']");
  const label = (await control.getText()).trim();
  if (paused && label === "Pause automatic connection") await control.click();
  if (!paused && label === "Resume automatic connection") await control.click();
};

export const readCachedHash = async (
  browser: TauriBrowser,
  relativePath: string,
): Promise<string | null> => {
  if (relativePath === "blob.bin") console.log("Large transfer digest request started.");
  const digest = await browser.execute(async (path: string) => {
    const testWindow = window as Window & {
      __syncpeerDigestCachedFile?: (path: string) => Promise<string | null>;
    };
    return testWindow.__syncpeerDigestCachedFile?.(path) ?? null;
  }, relativePath);
  if (relativePath === "blob.bin") console.log("Large transfer digest request returned.");
  return digest;
};

export const readSessionEventNames = async (
  browser: TauriBrowser,
): Promise<string[]> => {
  await browser.execute(() => {
    const tab = document.querySelector("[data-testid='tab-devices']");
    if (!(tab instanceof HTMLButtonElement)) throw new Error("Device tab is unavailable.");
    tab.click();
  });
  await browser.pause(50);
  const events = await browser.execute(() =>
    [...document.querySelectorAll(".item-meta")]
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => text.includes(" | "))
      .map((text) => text.split(" | ").at(-1) ?? "")
      .filter(Boolean)
      .slice(-80),
  );
  await browser.execute(() => {
    const tab = document.querySelector("[data-testid='tab-folders']");
    if (!(tab instanceof HTMLButtonElement)) throw new Error("Folder tab is unavailable.");
    tab.click();
  });
  return events;
};
