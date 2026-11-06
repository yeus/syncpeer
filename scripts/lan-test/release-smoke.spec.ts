import { browser } from "@wdio/globals";
import { createFreshEncryptedProfile } from "./profile-setup.js";
import { completeFirstRunDeviceName, readCurrentDeviceId } from "./ui-helpers.js";

describe("Packaged Linux desktop startup", () => {
  it("creates a fresh encrypted profile in a private desktop session", async () => {
    console.log("Packaged release smoke: confirm device name");
    await completeFirstRunDeviceName(browser, "Synthetic release smoke device");
    console.log("Packaged release smoke: read device identity");
    await readCurrentDeviceId(browser);
    console.log("Packaged release smoke: create optional Personal Space");
    await createFreshEncryptedProfile(browser);
    console.log("Packaged release smoke: complete");
  });
});
