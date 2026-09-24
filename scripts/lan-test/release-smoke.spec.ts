import assert from "node:assert/strict";
import { $ } from "@wdio/globals";

describe("Packaged Linux desktop startup", () => {
  it("creates a fresh encrypted profile in a private desktop session", async () => {
    await $("[data-testid='tab-devices']").click();
    const deviceId = $("[data-testid='current-device-id']");
    await deviceId.waitForExist({ timeout: 60_000 });
    assert.match(await deviceId.getText(), /^[A-Z2-7-]{40,}$/);

    await $("[data-testid='tab-folders']").click();
    await $("button=Folder settings · New folder").click();
    await $("//label[contains(., 'Master password (at least 16 characters)')]/input")
      .setValue("synthetic-release-smoke-master-password");
    await $("//label[contains(., 'Offline kit password')]/input")
      .setValue("synthetic-release-smoke-kit-password");
    await $("button=Generate encrypted offline kit").click();
    await $("a[download='syncpeer-offline-signing-kit.json']").waitForExist();
    const kit = JSON.parse(await $("textarea[readonly]").getValue()) as { publicKey?: unknown };
    assert.ok(kit.publicKey, "The synthetic recovery kit needs a public key.");
    await $("//label[contains(., 'I saved the kit')]/input").click();
    await $("button=Create encrypted profile").click();
    try {
      await $("button=Create encrypted profile").waitForExist({ reverse: true, timeout: 30_000 });
    } catch (error) {
      const issue = await $("p[role='alert']").getText().catch(() => "No profile error was shown.");
      throw new Error(`Packaged fresh-profile setup failed: ${issue}`, { cause: error });
    }
  });
});
