import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { createFreshEncryptedProfile } from "./profile-setup.js";
import { clickButtonByText } from "./ui-helpers.js";

async function openSettings(peer: WebdriverIO.Browser) {
  await peer.$("[data-testid='tab-folders']").waitForExist({ timeout: 60_000 });
  await clickButtonByText(peer, "Folders");
  await clickButtonByText(peer, "Folder settings · New folder");
}

async function importBackup(peer: WebdriverIO.Browser, backup: string, password: string) {
  await peer.$("//label[contains(., 'Or paste encrypted backup')]/textarea").setValue(backup);
  await peer.$("//label[contains(., 'Backup recovery password')]/input").setValue(password);
  await peer.$("//label[contains(., 'New device master password')]/input")
    .setValue("synthetic-replacement-master-password");
  await peer.$("button=Import backup into this new profile").waitForEnabled({ timeout: 30_000 });
  await clickButtonByText(peer, "Import backup into this new profile");
}

async function enrollReplacement(peer: WebdriverIO.Browser, kit: string, password: string) {
  await peer.execute(({ kit, password }) => {
    for (const [labelText, value] of [
      ["Or paste encrypted kit", kit],
      ["Offline kit password", password],
    ]) {
      const label = [...document.querySelectorAll("label")]
        .find(element => element.textContent?.includes(labelText));
      const field = label?.querySelector("textarea, input");
      if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) {
        throw new Error(`Recovery field ${labelText} is unavailable.`);
      }
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { kit, password });
  await peer.$("button=Enroll this replacement device").waitForEnabled({ timeout: 30_000 });
  await clickButtonByText(peer, "Enroll this replacement device");
}

async function expectFailure(peer: WebdriverIO.Browser, message: RegExp) {
  const alert = peer.$("p[role='alert']");
  await alert.waitForExist({ timeout: 30_000 });
  assert.match(await alert.getText(), message);
}

async function membershipRows(peer: WebdriverIO.Browser) {
  return peer.execute(() => {
    const heading = [...document.querySelectorAll("h2")]
      .find(value => value.textContent?.trim() === "Devices with access to this space");
    return [...(heading?.parentElement?.querySelectorAll("li") ?? [])]
      .map(row => ({ deviceId: row.querySelector("code")?.textContent?.trim(),
        state: row.textContent?.includes("revoked") ? "revoked" :
          row.textContent?.includes("this device") ? "local" : "active" }));
  });
}

describe("Packaged desktop offline recovery", () => {
  let kit = "", backup = "", ownerId = "", replacementId = "";
  const peers = () => browser as typeof browser & {
    owner: WebdriverIO.Browser; joiner: WebdriverIO.Browser;
  };

  it("exports a backup and separate kit from a protected identity", async () => {
    const { owner, joiner } = peers();
    await Promise.all([owner, joiner].map(async peer => {
      const devices = peer.$("[data-testid='tab-devices']");
      await devices.waitForExist({ timeout: 60_000 });
      await devices.click();
      const identity = peer.$("[data-testid='current-device-id']");
      await identity.waitForExist({ timeout: 60_000 });
      await peer.waitUntil(async () => /^[A-Z2-7-]{40,}$/.test(await identity.getText()),
        { timeout: 60_000, timeoutMsg: "The synthetic protected identity did not load." });
    }));
    ownerId = await owner.$("[data-testid='current-device-id']").getText();
    replacementId = await joiner.$("[data-testid='current-device-id']").getText();
    assert.notEqual(ownerId, replacementId);
    kit = await createFreshEncryptedProfile(owner);
    await owner.$("//label[contains(., 'Backup recovery password')]/input")
      .setValue("synthetic-backup-recovery-password");
    await owner.$("button=Export encrypted backup").waitForEnabled({ timeout: 30_000 });
    await clickButtonByText(owner, "Export encrypted backup");
    const exported = owner.$("//label[contains(., 'Encrypted backup — copy')]/textarea");
    await exported.waitForExist({ timeout: 30_000 });
    backup = await exported.getValue();
    assert.equal(JSON.parse(backup).format, 1);
    assert.equal(backup.includes("synthetic-release-smoke-master-password"), false);
    assert.equal(backup.includes(JSON.parse(kit).publicKey), false);
    await openSettings(joiner);
  });

  it("rejects a wrong password and corrupt backup without occupying the new profile", async () => {
    const { joiner } = peers();
    await importBackup(joiner, backup, "synthetic-wrong-backup-password");
    await expectFailure(joiner, /Backup operation failed/);
    assert.ok(await joiner.$("button=Import backup into this new profile").isExisting());
    const corrupt = JSON.parse(backup);
    corrupt.vault.ciphertext[0] ^= 1;
    await importBackup(joiner, JSON.stringify(corrupt), "synthetic-backup-recovery-password");
    await expectFailure(joiner, /Backup operation failed/);
    assert.ok(await joiner.$("button=Import backup into this new profile").isExisting());
    await importBackup(joiner, backup, "synthetic-backup-recovery-password");
    await joiner.$("button=Enroll this replacement device").waitForExist({ timeout: 30_000 });
    assert.deepEqual(await membershipRows(joiner), [{ deviceId: ownerId, state: "active" }]);
  });

  it("requires the matching kit and revokes the old device when enrolling the replacement", async () => {
    const { joiner } = peers();
    await enrollReplacement(joiner, kit, "synthetic-wrong-kit-password");
    await expectFailure(joiner, /recovery kit/i);
    const mismatched = JSON.parse(kit);
    mismatched.publicKey = "synthetic-mismatched-recovery-key";
    await enrollReplacement(joiner, JSON.stringify(mismatched), "synthetic-release-smoke-kit-password");
    await expectFailure(joiner, /does not match this personal space/);
    const corrupt = JSON.parse(kit);
    corrupt.ciphertext[0] ^= 1;
    await enrollReplacement(joiner, JSON.stringify(corrupt), "synthetic-release-smoke-kit-password");
    await expectFailure(joiner, /recovery kit/i);
    assert.deepEqual(await membershipRows(joiner), [{ deviceId: ownerId, state: "active" }]);
    await enrollReplacement(joiner, kit, "synthetic-release-smoke-kit-password");
    await joiner.$("button=Enroll this replacement device")
      .waitForExist({ reverse: true, timeout: 30_000 });
    assert.deepEqual(await membershipRows(joiner), [
      { deviceId: ownerId, state: "revoked" }, { deviceId: replacementId, state: "local" },
    ]);
    // Remount the UI and wait for its asynchronous refresh before checking persisted membership.
    await clickButtonByText(joiner, "Back");
    await openSettings(joiner);
    await joiner.waitUntil(async () => (await membershipRows(joiner)).length === 2, {
      timeout: 30_000,
      timeoutMsg: "Recovered device membership did not reload after remount.",
    });
    assert.deepEqual(await membershipRows(joiner), [
      { deviceId: ownerId, state: "revoked" }, { deviceId: replacementId, state: "local" },
    ]);
  });
});
