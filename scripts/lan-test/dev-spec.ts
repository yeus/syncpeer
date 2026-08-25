import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import type { Browser as WdioBrowser } from "webdriverio";
import type { BrowserExtension } from "@wdio/native-types";
import {
  LAN_FIXTURE_FOLDER_ID,
  LAN_FIXTURE_HELLO_CONTENT,
} from "./fixture-data.ts";
import { SYNCTHING_GLOBAL_DISCOVERY_SERVER } from "./fixture-data.ts";

type LanBrowser = WdioBrowser & BrowserExtension;
const lanBrowser = browser as unknown as LanBrowser;
const serverDeviceId = process.env.SYNCPEER_DEV_SERVER_DEVICE_ID?.trim() ?? "";
const clientRoot = process.env.SYNCPEER_LAN_CLIENT_ROOT ?? path.resolve(".tmp/syncpeer-dev-client");

if (!serverDeviceId) throw new Error("SYNCPEER_DEV_SERVER_DEVICE_ID is missing.");

const waitForText = async (text: string, timeout = 60_000): Promise<void> => {
  await lanBrowser.waitUntil(
    async () => (await lanBrowser.getPageSource()).includes(text),
    { timeout, timeoutMsg: "Timed out waiting for text: " + text },
  );
};

const setValue = async (testId: string, value: string): Promise<void> => {
  const element = $("[data-testid='" + testId + "']");
  await element.click();
  await element.setValue(value);
};

const connectUntilApproved = async (): Promise<void> => {
  const button = $("[data-testid='global-connect-button']");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if ((await button.getText()) === "Disconnect") return;
    if (await button.isEnabled()) await button.click();
    await lanBrowser.pause(2_000);
  }
  throw new Error("Timed out waiting for the server CLI to approve this client.");
};

const readCachedHash = async (relativePath: string): Promise<string | null> => {
  const records = await lanBrowser.tauri.execute((tauri) =>
    tauri.core.invoke("syncpeer_list_cached_files"),
  ) as Array<{ path: string; localPath?: string }>;
  const record = records.find((candidate) => candidate.path === relativePath);
  if (!record?.localPath) return null;
  const bytes = await lanBrowser.tauri.execute((tauri, filePath: string) =>
    tauri.core.invoke("syncpeer_read_binary_file", { request: { path: filePath } }),
    record.localPath,
  ) as number[];
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
};

describe("Syncpeer long-running development server", () => {
  it("connects after CLI approval and transfers the fixture", async () => {
    await waitForText("This Device", 60_000);
    const clientDeviceId = await $("[data-testid='current-device-id']").getText();
    assert.match(clientDeviceId, /^[A-Z2-7-]{40,}$/);
    console.log("\nSyncpeer client device ID: " + clientDeviceId);
    console.log("Approve this pending device in the server terminal.\n");

    await $("[data-testid='tab-devices']").click();
    const settings = $("[data-testid='connection-settings-toggle']");
    if (await settings.getAttribute("aria-expanded") !== "true") await settings.click();
    await $("[data-testid='connection-discovery-mode']")
      .selectByAttribute("value", "global");
    await setValue("connection-discovery-server", SYNCTHING_GLOBAL_DISCOVERY_SERVER);
    await setValue("connection-remote-id", serverDeviceId);
    await setValue("connection-timeout", "60000");
    await setValue("connection-cert", "");
    await setValue("connection-key", "");
    await connectUntilApproved();
    await waitForText("Path: relay", 120_000);

    await $("[data-testid='tab-folders']").click();
    await waitForText(LAN_FIXTURE_FOLDER_ID, 90_000);
    await $("//*[contains(@class, 'item-title') and normalize-space()='" +
      LAN_FIXTURE_FOLDER_ID + "']").click();
    await waitForText("hello.txt", 90_000);
    await $("//*[contains(@class, 'item-title') and normalize-space()='hello.txt']").click();
    await waitForText("Cached", 90_000);
    assert.equal(
      await readCachedHash("hello.txt"),
      createHash("sha256").update(LAN_FIXTURE_HELLO_CONTENT).digest("hex"),
    );

    const uploadPath = path.join(clientRoot, "development-upload.txt");
    fs.mkdirSync(clientRoot, { recursive: true });
    fs.writeFileSync(uploadPath, "uploaded from the Syncpeer development client\n");
    await $("#folder-upload-input").setValue(uploadPath);
    await waitForText("Uploaded development-upload.txt.", 90_000);
  });
});
