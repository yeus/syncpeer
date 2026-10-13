import { $, browser } from "@wdio/globals";
import { createFreshEncryptedProfile } from "./profile-setup.js";
import { readCurrentDeviceId } from "./ui-helpers.js";

describe("Packaged Linux desktop startup", () => {
  it("creates a fresh encrypted profile in a private desktop session", async () => {
    await $("[data-testid='tab-devices']").click();
    await readCurrentDeviceId(browser);

    await createFreshEncryptedProfile(browser);
  });
});
