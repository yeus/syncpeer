import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import type { Browser as WdioBrowser } from "webdriverio";
import type { BrowserExtension } from "@wdio/native-types";
import { coordinatorRequest } from "./coordinator.ts";
import type { LanFixture } from "./protocol.ts";

type LanBrowser = WdioBrowser & BrowserExtension;
const lanBrowser = browser as unknown as LanBrowser;

const baseUrl = process.env.SYNCPEER_LAN_COORDINATOR_URL ?? "";
const token = process.env.SYNCPEER_LAN_COORDINATOR_TOKEN ?? "";
const clientRoot = process.env.SYNCPEER_LAN_CLIENT_ROOT ?? path.resolve(".tmp/syncpeer-lan-client");
const untrustedIdentity = {
  deviceId: process.env.SYNCPEER_LAN_UNTRUSTED_DEVICE_ID ?? "",
  cert: process.env.SYNCPEER_LAN_UNTRUSTED_CERT ?? "",
  key: process.env.SYNCPEER_LAN_UNTRUSTED_KEY ?? "",
};

if (!baseUrl || !token) throw new Error("LAN coordinator environment is missing.");

const request = <T>(method: "GET" | "POST", pathname: string, body?: unknown) =>
  coordinatorRequest<T>({ baseUrl, token, method, pathname, body });

const reportPhase = async (
  phase: "direct" | "private-global" | "private-relay" | "public-smoke" | "encrypted-direct",
  status: "running" | "passed" | "failed" | "skipped",
  details?: unknown,
): Promise<void> => {
  await request("POST", "/v1/phase", { phase, status, details });
};

const runPhase = async (
  phase: Parameters<typeof reportPhase>[0],
  test: () => Promise<void>,
): Promise<void> => {
  await reportPhase(phase, "running");
  try {
    await test();
    await reportPhase(phase, "passed");
  } catch (error) {
    await reportPhase(phase, "failed", { error: String(error) }).catch(() => undefined);
    throw error;
  }
};

const fixture = async (): Promise<LanFixture> => {
  const deadline = Date.now() + 180_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await request<LanFixture>("GET", "/v1/fixture");
    } catch (error) {
      lastError = error;
      await lanBrowser.pause(500);
    }
  }
  throw new Error("Timed out waiting for LAN fixture: " + String(lastError));
};

const waitForText = async (text: string, timeout = 60_000): Promise<void> => {
  await lanBrowser.waitUntil(
    async () => (await lanBrowser.getPageSource()).includes(text),
    { timeout, timeoutMsg: "Timed out waiting for text: " + text },
  );
};

const clickTestId = async (testId: string): Promise<void> => {
  await $("[data-testid='" + testId + "']").click();
};

const setValue = async (testId: string, value: string): Promise<void> => {
  const element = $("[data-testid='" + testId + "']");
  await element.click();
  await element.setValue(value);
};

const chooseDiscoveryMode = async (mode: "direct" | "global"): Promise<void> => {
  const select = $("[data-testid='connection-discovery-mode']");
  await select.selectByAttribute("value", mode);
};

const clickItemTitle = async (name: string): Promise<void> => {
  const item = $("//*[contains(@class, 'item-title') and normalize-space()='" + name + "']");
  await item.click();
};

const connect = async (
  currentFixture: LanFixture,
  mode: "direct" | "global",
  identity?: { cert: string; key: string },
): Promise<void> => {
  await clickTestId("tab-devices");
  const settings = $("[data-testid='connection-settings-toggle']");
  if (await settings.getAttribute("aria-expanded") !== "true") await settings.click();
  await chooseDiscoveryMode(mode);
  if (mode === "direct") {
    await setValue("connection-host", currentFixture.serverHost);
    await setValue("connection-port", String(currentFixture.directPort));
  } else {
    await setValue("connection-discovery-server", currentFixture.discoveryServer);
    await setValue("connection-remote-id", currentFixture.remoteDeviceId);
  }
  await setValue("connection-cert", identity?.cert ?? "");
  await setValue("connection-key", identity?.key ?? "");
  await clickTestId("global-connect-button");
  await waitForText("Connected");
};

const disconnect = async (): Promise<void> => {
  await clickTestId("global-connect-button");
  await waitForText("Disconnected", 30_000);
};

const openFolders = async (): Promise<void> => {
  await clickTestId("tab-folders");
};

const downloadByName = async (name: string): Promise<void> => {
  await waitForText(name);
  await clickItemTitle(name);
  await waitForText("Cached", 90_000);
};

const uploadTextFile = async (name: string, content: string): Promise<void> => {
  const uploadPath = path.join(clientRoot, name);
  fs.mkdirSync(clientRoot, { recursive: true });
  fs.writeFileSync(uploadPath, content);
  const input = $("#folder-upload-input");
  await input.setValue(uploadPath);
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

describe("Syncpeer LAN integration", () => {
  let currentFixture: LanFixture;

  it("registers the real Tauri identity", async () => {
    await waitForText("This Device", 60_000);
    const deviceId = await $("[data-testid='current-device-id']").getText();
    assert.match(deviceId, /^[A-Z2-7-]{40,}$/);
    await request("POST", "/v1/register", { profile: "trusted", deviceId });
    currentFixture = await fixture();
  });

  it("downloads, uploads, and preserves cache integrity over direct TCP", async () => {
    await runPhase("direct", async () => {
      await connect(currentFixture, "direct");
      await openFolders();
      await waitForText(currentFixture.folderId);
      await clickItemTitle(currentFixture.folderId);
      await downloadByName("hello.txt");
      const expectedHello = currentFixture.expectedFiles.find((file) => file.path === "hello.txt");
      assert.ok(expectedHello);
      assert.equal(await readCachedHash("hello.txt"), expectedHello.sha256);

      await uploadTextFile("upload.txt", "uploaded from Syncpeer LAN test\n");
      await waitForText("Uploaded upload.txt.", 90_000);
      const uploaded = await request<{ sha256: string; size: number }>("POST", "/v1/action", {
        action: "verify-upload",
      });
      assert.equal(uploaded.sha256, createHash("sha256")
        .update("uploaded from Syncpeer LAN test\n")
        .digest("hex"));
    });
  });

  it("keeps a large transfer active while metadata churn runs", async () => {
    await runPhase("direct", async () => {
      const churn = request<{ ticks: number }>("POST", "/v1/action", {
        action: "churn",
        details: { durationMs: 12_000 },
      });
      await openFolders();
      await clickItemTitle("blob.bin");
      await waitForText("Cached", 120_000);
      const result = await churn;
      assert.ok(result.ticks >= 4);
    });
  });

  it("connects through private global discovery", async () => {
    await runPhase("private-global", async () => {
      await disconnect();
      await connect(currentFixture, "global");
    });
  });

  it("falls back through the private relay", async () => {
    await runPhase("private-relay", async () => {
      await request("POST", "/v1/action", { action: "switch-to-relay" });
      await disconnect();
      await connect(currentFixture, "global");
      await waitForText("Path: relay", 60_000);
    });
  });

  it("browses and downloads a receive-encrypted folder", async () => {
    await runPhase("encrypted-direct", async () => {
      assert.ok(untrustedIdentity.deviceId && untrustedIdentity.cert && untrustedIdentity.key);
      await request("POST", "/v1/action", {
        action: "add-untrusted",
        details: { deviceId: untrustedIdentity.deviceId },
      });
      await request("POST", "/v1/register", {
        profile: "untrusted",
        deviceId: untrustedIdentity.deviceId,
      });
      await disconnect();
      await connect(currentFixture, "direct", untrustedIdentity);
      await openFolders();
      await waitForText(currentFixture.encryptedFolderId, 90_000);
      const passwordInput = $("[data-testid='folder-password-" + currentFixture.encryptedFolderId + "']");
      if (!(await passwordInput.isExisting())) {
        await clickTestId("edit-folder-password-" + currentFixture.encryptedFolderId);
      }
      await setValue(`folder-password-${currentFixture.encryptedFolderId}`, currentFixture.encryptedPassword);
      await clickTestId(`unlock-folder-${currentFixture.encryptedFolderId}`);
      await waitForText("secret.txt", 90_000);
      await downloadByName("secret.txt");
      assert.equal(
        await readCachedHash("secret.txt"),
        currentFixture.encryptedExpected.sha256,
      );
    });
  });

  it("reports public discovery reachability without gating the LAN run", async () => {
    await reportPhase("public-smoke", "running");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(
        "https://discovery.syncthing.net/v2/?device=" + encodeURIComponent(currentFixture.remoteDeviceId),
        { signal: controller.signal },
      );
      await reportPhase("public-smoke", "passed", { status: response.status });
    } catch (error) {
      await reportPhase("public-smoke", "skipped", { error: String(error) });
    } finally {
      clearTimeout(timer);
    }
  });
});
