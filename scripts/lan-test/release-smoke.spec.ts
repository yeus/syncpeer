import { browser } from "@wdio/globals";
import { createFreshEncryptedProfile } from "./profile-setup.js";
import { readCurrentDeviceId } from "./ui-helpers.js";

describe("Packaged Linux desktop startup", () => {
  it("creates a fresh encrypted profile in a private desktop session", async () => {
    await browser.execute(() => {
      (document.querySelector("[data-testid='tab-devices']") as HTMLButtonElement).click();
    });
    await readCurrentDeviceId(browser);

    await browser.$("[data-testid='personal-space-onboarding']")
      .waitForExist({ timeout: 30_000 });
    await createFreshEncryptedProfile(browser);
  });
});
