import assert from "node:assert/strict";

export async function createFreshEncryptedProfile(peer: WebdriverIO.Browser) {
  await peer.$("[data-testid='tab-folders']").click();
  await peer.$("button=Folder settings · New folder").click();
  await peer.$("//label[contains(., 'Master password (at least 16 characters)')]/input")
    .setValue("synthetic-release-smoke-master-password");
  await peer.$("//label[contains(., 'Offline kit password')]/input")
    .setValue("synthetic-release-smoke-kit-password");
  await peer.$("button=Generate encrypted offline kit").click();
  await peer.$("a[download='syncpeer-offline-signing-kit.json']").waitForExist();
  const kit = JSON.parse(await peer.$("textarea[readonly]").getValue()) as { publicKey?: unknown };
  assert.ok(kit.publicKey, "The synthetic recovery kit needs a public key.");
  await peer.$("//label[contains(., 'I saved the kit')]/input").click();
  await peer.$("button=Create encrypted profile").click();
  try {
    await peer.$("button=Create encrypted profile").waitForExist({ reverse: true, timeout: 30_000 });
  } catch (error) {
    const issue = await peer.$("p[role='alert']").getText().catch(() => "No profile error was shown.");
    throw new Error(`Packaged fresh-profile setup failed: ${issue}`, { cause: error });
  }
}
