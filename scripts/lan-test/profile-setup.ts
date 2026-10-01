import assert from "node:assert/strict";
import { clickButtonByText } from "./ui-helpers.js";

export async function createFreshEncryptedProfile(peer: WebdriverIO.Browser) {
  await peer.$("[data-testid='tab-folders']").click();
  await peer.$("button=Folder settings · New folder").click();
  await peer.$("//label[contains(., 'Master password (at least 16 characters)')]/input")
    .setValue("synthetic-release-smoke-master-password");
  await peer.$("//label[contains(., 'Offline kit password')]/input")
    .setValue("synthetic-release-smoke-kit-password");
  const kitButton = peer.$("button=Generate encrypted offline kit");
  if (!await kitButton.isEnabled()) throw new Error("Packaged offline-kit button is disabled before generation.");
  // Under Xvfb, WebKitWebDriver has targeted the surrounding FORM instead of
  // this offscreen button. A DOM click exercises the same application handler.
  const clickedAt = Date.now();
  await clickButtonByText(peer, "Generate encrypted offline kit");
  const clickMs = Date.now() - clickedAt;
  try {
    await peer.$("a[download='syncpeer-offline-signing-kit.json']")
      .waitForExist({ timeout: 30_000 });
  } catch (cause) {
    const state = await peer.execute(() => ({
      error: document.querySelector("p[role='alert']")?.textContent?.trim() ?? "",
      buttonPresent: [...document.querySelectorAll("button")]
        .some(button => button.textContent?.trim() === "Generate encrypted offline kit"),
      buttonDisabled: [...document.querySelectorAll("button")]
        .find(button => button.textContent?.trim() === "Generate encrypted offline kit")?.disabled ?? false,
      kitTextPresent: Boolean(document.querySelector("textarea[readonly]")),
      kitLinkPresent: Boolean(document.querySelector("a[download='syncpeer-offline-signing-kit.json']")),
      passwordLength: [...document.querySelectorAll("label")]
        .find(label => label.textContent?.includes("Offline kit password"))
        ?.querySelector("input")?.value.length ?? -1,
    })).catch(() => ({ diagnosticsUnavailable: true }));
    throw new Error(`Packaged offline-kit creation did not complete after click ${clickMs} ms: ` +
      JSON.stringify(state), { cause });
  }
  const kit = JSON.parse(await peer.$("textarea[readonly]").getValue()) as { publicKey?: unknown };
  assert.ok(kit.publicKey, "The synthetic recovery kit needs a public key.");
  const saved = await peer.execute(() => {
    const input = [...document.querySelectorAll("label")]
      .find(label => label.textContent?.includes("I saved the kit"))?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) return false;
    if (!input.checked) input.click();
    return input.checked;
  });
  assert.ok(saved, "The synthetic kit acknowledgement was not selected.");
  await clickButtonByText(peer, "Create encrypted profile");
  try {
    await peer.$("button=Create encrypted profile").waitForExist({ reverse: true, timeout: 30_000 });
  } catch (error) {
    const issue = await peer.$("p[role='alert']").getText().catch(() => "No profile error was shown.");
    throw new Error(`Packaged fresh-profile setup failed: ${issue}`, { cause: error });
  }
}
