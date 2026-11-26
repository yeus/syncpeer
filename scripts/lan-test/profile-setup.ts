import assert from "node:assert/strict";
import { clickButtonByText, openOptionalPersonalSpaceSetup } from "./ui-helpers.js";

export async function createFreshEncryptedProfile(peer: WebdriverIO.Browser) {
  await openOptionalPersonalSpaceSetup(peer);
  console.log("Packaged Personal Space smoke: optional setup form ready");
  await peer.execute(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>(
      "[data-testid='optional-personal-space-setup'] form input[autocomplete='new-password']");
    if (inputs.length !== 2) throw new Error("Personal Space setup must offer master and offline-kit passwords.");
    for (const [index, value] of ["synthetic-release-smoke-master-password", "synthetic-release-smoke-kit-password"].entries()) {
      inputs[index].value = value;
      inputs[index].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[index].dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  await peer.waitUntil(() => peer.execute(() => {
    const button = [...document.querySelectorAll("button")].find(item =>
      item.textContent?.trim() === "Generate encrypted offline kit");
    return button instanceof HTMLButtonElement && !button.disabled;
  }), { timeout: 30_000, timeoutMsg: "Offline-kit generation button is not enabled." });
  console.log("Packaged Personal Space smoke: generating offline signing kit");
  // WebKitWebDriver sometimes misses offscreen button clicks in Xvfb.
  await clickButtonByText(peer, "Generate encrypted offline kit");
  try {
    await peer.waitUntil(() => peer.execute(() =>
      !!document.querySelector("[data-testid='optional-personal-space-setup'] a[download='syncpeer-offline-signing-kit.json']")),
    { timeout: 60_000, timeoutMsg: "Encrypted offline kit did not appear." });
  } catch (cause) {
    const alert = await peer.execute(() => document.querySelector("[data-testid='general-settings-page'] p[role='alert']")?.textContent ?? "No profile error was shown.");
    throw new Error("Packaged offline-kit creation failed: " + alert, { cause });
  }
  console.log("Packaged Personal Space smoke: offline signing kit ready");
  const encodedKit = await peer.execute(() => document.querySelector<HTMLTextAreaElement>(
    "[data-testid='optional-personal-space-setup'] textarea[readonly]")?.value ?? "");
  assert.ok((JSON.parse(encodedKit) as { publicKey?: unknown }).publicKey,
    "The synthetic recovery kit must have a public key.");

  const saved = await peer.execute(() => {
    const label = [...document.querySelectorAll("[data-testid='optional-personal-space-setup'] label")]
      .find(value => value.textContent?.includes("I saved the kit and its password"));
    const checkbox = label?.querySelector("input");
    if (!(checkbox instanceof HTMLInputElement)) return false;
    if (!checkbox.checked) checkbox.click();
    return checkbox.checked;
  });
  assert.ok(saved, "The synthetic recovery kit must be acknowledged.");

  await peer.waitUntil(() => peer.execute(() => {
    const button = document.querySelector("[data-testid='optional-personal-space-setup'] form button.primary");
    return button instanceof HTMLButtonElement && !button.disabled;
  }), { timeout: 30_000, timeoutMsg: "Create Personal Space button is not enabled." });
  console.log("Packaged Personal Space smoke: creating Personal Space");
  const beforeClickMs = performance.now();
  await peer.execute(() => {
    const button = document.querySelector("[data-testid='optional-personal-space-setup'] form button.primary");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Create Personal Space button unavailable.");
    // Launch the native-backed async form handler in a later browser task,
    // after WebDriver's script-evaluation request has returned. Executing
    // click() inside a WebKitWebDriver script request can deadlock its response
    // on some NixOS/WebKit combinations even though the submit starts.
    setTimeout(() => { if (button.isConnected) button.click(); }, 0);
  });
  console.log(`Packaged Personal Space smoke: create click returned in ${Math.round(performance.now() - beforeClickMs)}ms`);
  try {
    await peer.waitUntil(() => peer.execute(() =>
      !document.querySelector("[data-testid='optional-personal-space-setup']")),
    { timeout: 60_000, timeoutMsg: "Personal Space setup did not finish." });
  } catch (cause) {
    const alert = await peer.execute(() => document.querySelector("[data-testid='general-settings-page'] p[role='alert']")?.textContent ?? "No profile error was shown.");
    throw new Error("Packaged Personal Space creation failed: " + alert, { cause });
  }
  console.log("Packaged Personal Space smoke: Personal Space created");
  return encodedKit;
}
