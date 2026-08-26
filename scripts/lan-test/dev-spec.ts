import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import {
  LAN_FIXTURE_FOLDER_ID,
  LAN_FIXTURE_HELLO_CONTENT,
} from "./fixture-data.ts";
import { normalizeDiscoveryServer } from "../../packages/core/src/ui/discoveryServer.ts";
import {
  connectUntilApproved,
  readCachedHash,
  selectDiscoveryMode,
  setUploadFile,
  setValue,
  type TauriBrowser,
  waitForText,
} from "./ui-helpers.ts";

const lanBrowser = browser as unknown as TauriBrowser;
const serverDeviceId = process.env.SYNCPEER_DEV_SERVER_DEVICE_ID?.trim() ?? "";
const clientRoot = process.env.SYNCPEER_LAN_CLIENT_ROOT ?? path.resolve(".tmp/syncpeer-dev-client");
const discoveryServer = (): string =>
  normalizeDiscoveryServer(process.env.SYNCPEER_LAN_DISCOVERY_SERVER?.trim());

if (!serverDeviceId) throw new Error("SYNCPEER_DEV_SERVER_DEVICE_ID is missing.");

describe("Syncpeer long-running development server", () => {
  it("connects after CLI approval and transfers the fixture", async () => {
    await $("[data-testid='tab-devices']").click();
    await waitForText(lanBrowser, "This Device", 60_000);
    const clientDeviceId = await $("[data-testid='current-device-id']").getText();
    assert.match(clientDeviceId, /^[A-Z2-7-]{40,}$/);
    console.log("\nSyncpeer client device ID: " + clientDeviceId);
    console.log("Approve this pending device in the server terminal.\n");

    await $("[data-testid='tab-devices']").click();
    const settings = $("[data-testid='connection-settings-toggle']");
    if (await settings.getAttribute("aria-expanded") !== "true") await settings.click();
    await selectDiscoveryMode(lanBrowser, "global");
    await setValue("connection-discovery-server", discoveryServer());
    await setValue("connection-remote-id", serverDeviceId);
    await setValue("connection-timeout", "60000");
    await setValue("connection-cert", "");
    await setValue("connection-key", "");
    await connectUntilApproved(lanBrowser);
    await waitForText(lanBrowser, "Path: relay", 120_000);

    await $("[data-testid='tab-folders']").click();
    await waitForText(lanBrowser, LAN_FIXTURE_FOLDER_ID, 90_000);
    await $("//*[contains(@class, 'item-title') and normalize-space()='" +
      LAN_FIXTURE_FOLDER_ID + "']").click();
    await waitForText(lanBrowser, "hello.txt", 90_000);
    await $("//*[contains(@class, 'item-title') and normalize-space()='hello.txt']").click();
    await waitForText(lanBrowser, "Cached", 90_000);
    assert.equal(
      await readCachedHash(lanBrowser, "hello.txt"),
      createHash("sha256").update(LAN_FIXTURE_HELLO_CONTENT).digest("hex"),
    );

    const uploadPath = path.join(clientRoot, "development-upload.txt");
    fs.mkdirSync(clientRoot, { recursive: true });
    fs.writeFileSync(uploadPath, "uploaded from the Syncpeer development client\n");
    await setUploadFile(lanBrowser, uploadPath);
    await waitForText(lanBrowser, "Uploaded development-upload.txt.", 90_000);
  });
});
