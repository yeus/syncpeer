import assert from "node:assert/strict";
import { $, browser } from "@wdio/globals";
import { createFreshEncryptedProfile } from "./profile-setup.js";

describe("Packaged Linux desktop startup", () => {
  it("creates a fresh encrypted profile in a private desktop session", async () => {
    await $("[data-testid='tab-devices']").click();
    const deviceId = $("[data-testid='current-device-id']");
    await deviceId.waitForExist({ timeout: 60_000 });
    assert.match(await deviceId.getText(), /^[A-Z2-7-]{40,}$/);

    await createFreshEncryptedProfile(browser);
  });
});
