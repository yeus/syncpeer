import fs from "node:fs";
import path from "node:path";
import { $, browser } from "@wdio/globals";
import type { Browser as WdioBrowser } from "webdriverio";
import type { BrowserExtension } from "@wdio/native-types";

export type TauriBrowser = WdioBrowser & BrowserExtension;

/** Finish the name-only first-run screen before the navigation tabs can appear. */
export async function completeFirstRunDeviceName(
  peer: WebdriverIO.Browser, name = "Synthetic desktop device",
) {
  const initial = await peer.waitUntil(async () => peer.execute(() => {
    if (document.querySelector("[data-testid='device-name-onboarding']")) return "name";
    if (document.querySelector("[data-testid='tab-devices']")) return "ready";
    return null;
  }), { timeout: 60_000, interval: 500, timeoutMsg: "Neither device naming nor the main navigation appeared." });
  if (initial === "name") {
    await peer.$("[data-testid='local-name-entry']").setValue(name);
    // Avoid headless WebKit/Xvfb window-focus races while preserving real form validation.
    await peer.execute(() => {
      const form = document.querySelector("[data-testid='device-name-onboarding'] form");
      if (!(form instanceof HTMLFormElement)) throw new Error("Device-name form is unavailable.");
      form.requestSubmit();
    });
    await peer.$("[data-testid='device-name-onboarding']")
      .waitForExist({ reverse: true, timeout: 30_000 });
  }
  await peer.$("[data-testid='tab-devices']").waitForExist({ timeout: 30_000 });
}

/** Navigate the real Settings hierarchy, including returning to the original tab. */
export async function closeSettings(peer: WebdriverIO.Browser) {
  for (let depth = 0; depth < 4; depth++) {
    const back = peer.$("[data-testid='settings-back'], [data-testid='about-back'], [data-testid='diagnostics-back']");
    if (!await back.isExisting()) return;
    await peer.execute(() => {
      const button = document.querySelector("[data-testid='settings-back'], [data-testid='about-back'], [data-testid='diagnostics-back']");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Settings back button disappeared.");
      button.click();
    });
    await peer.pause(100);
  }
}
export async function openSettingsSection(peer: WebdriverIO.Browser, section: string) {
  if (await peer.$(`[data-testid='settings-${section}']`).isExisting()) return;
  if (!await peer.$("[data-testid='settings-overview']").isExisting()) {
    await closeSettings(peer);
    await completeFirstRunDeviceName(peer);
    // Native WebKit clicks can be lost when the Xvfb window is not active.
    await peer.execute(() => {
      const button = document.querySelector("[data-testid='connection-settings-toggle']");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Settings toggle is unavailable.");
      button.click();
    });
    await peer.$("[data-testid='settings-overview']").waitForExist({ timeout: 30_000 });
  }
  const selector = section === "personal-space" ? "general-settings" : `open-settings-${section}`;
  await peer.$(`[data-testid='${selector}']`).waitForExist({ timeout: 30_000 });
  await peer.execute((id: string) => {
    const button = document.querySelector(`[data-testid='${id}']`);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Settings section ${id} is unavailable.`);
    button.click();
  }, selector);
  await peer.$(section === "about" ? "[data-testid='about-page']" : `[data-testid='settings-${section}']`).waitForExist({ timeout: 30_000 });
}
export async function openGeneralSettings(peer: WebdriverIO.Browser) {
  await openSettingsSection(peer, "personal-space");
  await peer.$("[data-testid='general-settings-page']").waitForExist({ timeout: 30_000 });
}

/** Personal Space is optional and its creation/join forms start collapsed. */
export async function openOptionalPersonalSpaceSetup(peer: WebdriverIO.Browser) {
  await openGeneralSettings(peer);
  const setup = peer.$("[data-testid='optional-personal-space-setup']");
  await setup.waitForExist({ timeout: 60_000 });
  await peer.execute(() => {
    const panel = document.querySelector("[data-testid='optional-personal-space-setup']");
    if (panel instanceof HTMLDetailsElement && !panel.open) panel.querySelector("summary")?.click();
  });
  await peer.waitUntil(() => peer.execute(() => {
    const panel = document.querySelector("[data-testid='optional-personal-space-setup']");
    return panel instanceof HTMLDetailsElement && panel.open && !!panel.querySelector("form input[autocomplete='new-password']");
  }), { timeout: 30_000, timeoutMsg: "Personal Space form is not open." });
  return setup;
}

/** Choose an actual folder row, then open its settings without browsing it. */
export async function openFolderSettings(peer: WebdriverIO.Browser, folder: string) {
  await peer.execute(() => {
    const tab = document.querySelector("[data-testid='tab-folders']");
    if (!(tab instanceof HTMLButtonElement)) throw new Error("Folder tab is unavailable.");
    tab.click();
  });
  await peer.execute(() => {
    const root = document.querySelector("[data-testid=folder-root-back]");
    if (root instanceof HTMLButtonElement) root.click();
  });
  await peer.waitUntil(async () => peer.execute((selected: string) => {
    const rows = [...document.querySelectorAll("[data-testid^='folder-root-']")];
    const row = rows.find(element => element.getAttribute("data-testid") === `folder-root-${selected}`
      || element.querySelector(".item-title")?.textContent?.trim() === selected);
    const settings = row?.closest("li")?.querySelector("button[aria-label='Folder settings']");
    if (!(settings instanceof HTMLButtonElement)) return false;
    settings.click();
    return true;
  }, folder), { timeout: 30_000, timeoutMsg: "The selected folder's settings menu is unavailable." });
  await peer.$("[data-testid='folder-settings-page']").waitForExist({ timeout: 30_000 });
}

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

/**
 * The Devices tab renders an "Unavailable" placeholder until the native
 * identity resolves, so wait for the real device ID instead of reading once.
 */
export const readCurrentDeviceId = async (browser: WebdriverIO.Browser): Promise<string> => {
  await closeSettings(browser);
  await browser.execute(() => {
    const tab = document.querySelector("[data-testid='tab-devices']");
    if (!(tab instanceof HTMLButtonElement)) throw new Error("Devices tab is unavailable.");
    tab.click();
  });
  await browser.execute(() => { const details = document.querySelector("details.local-details"); if (details instanceof HTMLDetailsElement) details.open = true; });
  const element = browser.$("[data-testid='current-device-id']");
  await browser.waitUntil(
    async () => /^[A-Z2-7-]{40,}$/.test(await element.getText()),
    { timeout: 60_000, timeoutMsg: "The Tauri device identity never became available." },
  );
  return element.getText();
};

export const setValue = async (testId: string, value: string): Promise<void> => {
  await $("[data-testid='" + testId + "']").waitForExist({ timeout: 30_000 });
  // Drive real input/change handlers without depending on Xvfb window focus.
  await browser.execute(({ testId, value }) => {
    const field = document.querySelector(`[data-testid='${testId}']`);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement))
      throw new Error("Input is unavailable: " + testId);
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }, { testId, value });
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
  if (label === "Back" && await browser.$("[data-testid='settings-back']").isExisting()) {
    await closeSettings(browser);
    return;
  }
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
  await openSettingsSection(browser, "network");
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
  await browser.waitUntil(async () => {
    const values = await Promise.all([
      browser.$("[data-testid='connection-remote-id']").getValue(),
      browser.$("[data-testid='connection-host']").getValue(),
      browser.$("[data-testid='connection-port']").getValue(),
      browser.$("[data-testid='connection-listen-port']").getValue(),
    ]);
    return values[0] === settings.remoteId && values[1] === settings.host &&
      values[2] === String(settings.remotePort) && values[3] === String(settings.listenPort);
  }, { timeout: 5_000, timeoutMsg: "Direct connection settings did not update." });
};

export const setUploadBytes = async (
  browser: Pick<TauriBrowser, "execute">,
  name: string,
  bytes: Uint8Array,
): Promise<void> => {
  await browser.execute((payload: { name: string; bytes: number[] }) => {
    const input = document.getElementById("folder-upload-input") as HTMLInputElement | null;
    if (!input) throw new Error("The folder upload input is not mounted.");
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(payload.bytes)], payload.name));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { name, bytes: Array.from(bytes) });
};

export const setUploadFile = async (
  browser: TauriBrowser,
  filePath: string,
): Promise<void> => {
  await setUploadBytes(browser, path.basename(filePath), fs.readFileSync(filePath));
};
export const connectUntilApproved = async (
  browser: TauriBrowser,
  timeout = 10 * 60_000,
): Promise<void> => {
  await closeSettings(browser);
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
  browser: WebdriverIO.Browser,
  paused: boolean,
): Promise<void> => {
  // The global pause control is available without Expert view.
  // Avoid changing a persisted appearance setting during connection tests.
  await closeSettings(browser);
  const details = browser.$("[data-testid='connection-status-toggle']");
  if (await details.getAttribute("aria-expanded") !== "true") await browser.execute(() => {
    const button = document.querySelector("[data-testid='connection-status-toggle']");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Connection details unavailable.");
    button.click();
  });
  const control = browser.$("[data-testid='expert-connection-control']");
  await control.waitForEnabled({ timeout: 5_000 });
  const expected = paused ? "Resume automatic connection" : "Pause automatic connection";
  const action = paused ? "Pause automatic connection" : "Resume automatic connection";
  const label = (await control.getText()).trim();
  if (label !== expected && label !== action)
    throw new Error(`Unexpected automatic connection control: ${label}.`);
  if (label === action) await clickButtonByText(browser, action);
  await browser.waitUntil(async () => (await control.getText()).trim() === expected, {
    timeout: 5_000,
    timeoutMsg: `Automatic connection did not become ${paused ? "paused" : "resumed"}.`,
  });
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
/** The diagnostics page does not mount the current journal until expanded. */
export async function openSessionLogs(peer: WebdriverIO.Browser) {
  await openSettingsSection(peer, "diagnostics");
  await peer.execute(() => {
    const panel = [...document.querySelectorAll("details")].find(details =>
      details.querySelector("summary")?.textContent?.trim().startsWith("View logs ("));
    if (!(panel instanceof HTMLDetailsElement)) throw new Error("Session log panel unavailable.");
    if (!panel.open) panel.querySelector("summary")?.click();
  });
  await peer.waitUntil(() => peer.execute(() =>
    [...document.querySelectorAll("details[open] > summary")].some(summary =>
      summary.textContent?.trim().startsWith("View logs ("))),
  { timeout: 5_000, timeoutMsg: "Session logs did not expand." });
}


export const readSessionEventNames = async (
  browser: TauriBrowser,
): Promise<string[]> => {
  await openSessionLogs(browser);
  const events = await browser.execute(() =>
    [...document.querySelectorAll(".item-meta")]
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => text.includes(" | "))
      .map((text) => text.split(" | ").at(-1) ?? "")
      .filter(Boolean)
      .slice(0, 80),
  );
  await closeSettings(browser);
  await browser.execute(() => {
    const tab = document.querySelector("[data-testid='tab-folders']");
    if (!(tab instanceof HTMLButtonElement)) throw new Error("Folder tab is unavailable.");
    tab.click();
  });
  return events;
};
