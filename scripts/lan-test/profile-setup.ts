import assert from "node:assert/strict";
import { clickButtonByText, openOptionalPersonalSpaceSetup } from "./ui-helpers.js";

export async function createFreshEncryptedProfile(peer: WebdriverIO.Browser) {
  const setup = await openOptionalPersonalSpaceSetup(peer);
  const form = setup.$("form");
  const passwords = await form.$$("input[autocomplete='new-password']");
  assert.equal(passwords.length, 2, "Personal Space setup must offer master and offline-kit passwords.");
  await passwords[0].setValue("synthetic-release-smoke-master-password");
  await passwords[1].setValue("synthetic-release-smoke-kit-password");

  const generate = form.$("button=Generate encrypted offline kit");
  await generate.waitForEnabled({ timeout: 30_000 });
  // WebKitWebDriver sometimes misses offscreen button clicks in Xvfb.
  await clickButtonByText(peer, "Generate encrypted offline kit");
  try {
    await setup.$("a[download='syncpeer-offline-signing-kit.json']")
      .waitForExist({ timeout: 60_000 });
  } catch (cause) {
    const alert = await peer.$("[data-testid='general-settings-page'] p[role='alert']")
      .getText().catch(() => "No profile error was shown.");
    throw new Error("Packaged offline-kit creation failed: " + alert, { cause });
  }
  const encodedKit = await setup.$("textarea[readonly]").getValue();
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

  const create = form.$("button.primary");
  await create.waitForEnabled({ timeout: 30_000 });
  await clickButtonByText(peer, (await create.getText()).trim());
  try {
    await setup.waitForExist({ reverse: true, timeout: 60_000 });
  } catch (cause) {
    const alert = await peer.$("[data-testid='general-settings-page'] p[role='alert']")
      .getText().catch(() => "No profile error was shown.");
    throw new Error("Packaged Personal Space creation failed: " + alert, { cause });
  }
  return encodedKit;
}
