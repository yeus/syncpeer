import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import type { Browser as WdioBrowser } from "webdriverio";
import type { BrowserExtension } from "@wdio/native-types";
import { coordinatorRequest } from "./coordinator.ts";
import type { LanFixture } from "./protocol.ts";
import {
  clickDownloadButton,
  clickItemTitle,
  readCachedHash,
  readSessionEventNames,
  selectDiscoveryMode,
  setUploadFile,
  setValue,
  waitForDisconnected,
  waitForText,
} from "./ui-helpers.ts";

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
  phase: "direct" | "lan-discovery" | "quic" | "global" | "relay" | "public-smoke" | "encrypted-direct",
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

const clickTestId = async (testId: string): Promise<void> => {
  await $("[data-testid='" + testId + "']").click();
};
const connect = async (
  currentFixture: LanFixture,
  mode: "automatic" | "direct" | "lan" | "global",
  identity?: { cert: string; key: string },
): Promise<void> => {
  await clickTestId("tab-devices");
  const settings = $("[data-testid='connection-settings-toggle']");
  if (await settings.getAttribute("aria-expanded") !== "true") await settings.click();
  await selectDiscoveryMode(lanBrowser, mode);
  const remoteDeviceId = process.env.SYNCPEER_LAN_REMOTE_DEVICE_ID?.trim()
    || currentFixture.remoteDeviceId;
  await setValue("connection-remote-id", remoteDeviceId);
  if (mode === "direct" || mode === "automatic") {
    await setValue("connection-host", currentFixture.serverHost);
    await setValue("connection-port", String(currentFixture.directPort));
  } else if (mode === "global") {
    await setValue("connection-discovery-server", currentFixture.discoveryServer);
  }
  await setValue("connection-timeout", "60000");
  await setValue("connection-cert", identity?.cert ?? "");
  await setValue("connection-key", identity?.key ?? "");
  await clickTestId("global-connect-button");
  try {
    await waitForText(lanBrowser, "Connected");
  } catch (error) {
    const diagnostics = await lanBrowser.execute(() => ({
      error: document.querySelector(".error")?.textContent?.trim() ?? "",
      status: document.querySelector("[data-testid='connection-status']")?.textContent?.trim() ?? "",
      button: document.querySelector("[data-testid='global-connect-button']")?.textContent?.trim() ?? "",
    }));
    throw new Error(`${String(error)} (${JSON.stringify(diagnostics)})`, { cause: error });
  }
};

const disconnect = async (): Promise<void> => {
  const button = $("[data-testid='global-connect-button']");
  if ((await button.getText()).trim() === "Connect") return;
  await button.click();
  await waitForDisconnected(lanBrowser, 30_000);
};

const openFolders = async (): Promise<void> => {
  await clickTestId("tab-folders");
};

const downloadByName = async (name: string): Promise<void> => {
  await waitForText(lanBrowser, name);
  await clickDownloadButton(lanBrowser, name);
  await waitForText(lanBrowser, "Downloaded " + name, 90_000);
};

const uploadTextFile = async (name: string, content: string): Promise<void> => {
  const uploadPath = path.join(clientRoot, name);
  fs.mkdirSync(clientRoot, { recursive: true });
  fs.writeFileSync(uploadPath, content);
  await setUploadFile(lanBrowser, uploadPath);
};

describe("Syncpeer LAN integration", () => {
  let currentFixture: LanFixture;

  it("registers the real Tauri identity", async () => {
    await clickTestId("tab-devices");
    await waitForText(lanBrowser, "This Device", 60_000);
    const deviceId = await $("[data-testid='current-device-id']").getText();
    assert.match(deviceId, /^[A-Z2-7-]{40,}$/);
    if (process.env.SYNCPEER_LAN_MANUAL_IDS !== "1") {
      await request("POST", "/v1/register", { profile: "trusted", deviceId });
    }
    currentFixture = await fixture();
  });

  it("downloads, uploads, and preserves cache integrity over direct TCP", async () => {
    await runPhase("direct", async () => {
      await lanBrowser.tauri.execute((tauri) =>
        tauri.core.invoke("syncpeer_clear_cache"),
      );
      await connect(currentFixture, "direct");
      await openFolders();
      await waitForText(lanBrowser, currentFixture.folderId);
      await clickItemTitle(lanBrowser, currentFixture.folderId);
      await downloadByName("hello.txt");
      const expectedHello = currentFixture.expectedFiles.find((file) => file.path === "hello.txt");
      assert.ok(expectedHello);
      assert.equal(await readCachedHash(lanBrowser, "hello.txt"), expectedHello.sha256);

      await uploadTextFile("upload.txt", "uploaded from Syncpeer LAN test\n");
      await waitForText(lanBrowser, "Uploaded upload.txt.", 90_000);
      const uploaded = await request<{ sha256: string; size: number }>("POST", "/v1/action", {
        action: "verify-upload",
      }).catch(async (error) => {
        console.log(`Safe session events: ${(await readSessionEventNames(lanBrowser)).join(", ")}`);
        throw error;
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
      await clickDownloadButton(lanBrowser, "blob.bin");
      await waitForText(lanBrowser, "Downloaded blob.bin", 120_000);
      const result = await churn;
      assert.ok(result.ticks >= 4);
    });
  });

  it("connects through LAN discovery", async function () {
    if (process.env.SYNCPEER_LAN_SELF === "1") {
      this.skip();
      return;
    }
    await runPhase("lan-discovery", async () => {
      await disconnect();
      await connect(currentFixture, "lan");
    });
  });

  it("connects to a real Syncthing QUIC listener through Tauri", async function () {
    if (process.env.SYNCPEER_LAN_SELF !== "1") {
      await reportPhase("quic", "skipped", {
        reason: "dedicated QUIC transport switching is exercised by the self-hosted fixture",
      });
      this.skip();
      return;
    }
    await runPhase("quic", async () => {
      if (!currentFixture) {
        await clickTestId("tab-devices");
        await waitForText(lanBrowser, "This Device", 60_000);
        const deviceId = await $("[data-testid='current-device-id']").getText();
        await request("POST", "/v1/register", { profile: "trusted", deviceId });
        currentFixture = await fixture();
      }
      await request("POST", "/v1/action", {
        action: "switch-transport",
        details: { profile: "quic" },
      });
      await disconnect();
      const identity = await lanBrowser.tauri.execute((tauri) =>
        tauri.core.invoke("syncpeer_read_default_cli_identity"),
      ) as { certPem: string; keyPem: string };
      const probe = await lanBrowser.tauri.execute(
        (tauri, request) => tauri.core.invoke("syncpeer_quic_open", { request }),
        {
          host: currentFixture.serverHost,
          port: currentFixture.directPort,
          certPem: identity.certPem,
          keyPem: identity.keyPem,
          caPem: null,
          timeoutMs: 15_000,
          keepaliveMs: 15_000,
          idleTimeoutMs: 30_000,
        },
      ) as { sessionId: number; peerCertificateDer: number[] };
      assert.ok(probe.peerCertificateDer.length > 0);
      await lanBrowser.tauri.execute(
        (tauri, sessionId) => tauri.core.invoke("syncpeer_quic_close", {
          request: { sessionId },
        }),
        probe.sessionId,
      );
      await connect(currentFixture, "automatic");
      await waitForText(lanBrowser, "quic://", 60_000);
      await request("POST", "/v1/action", {
        action: "switch-transport",
        details: { profile: "tcp-quic" },
      });
    });
  });

  it("connects through official global discovery", async function () {
    if (process.env.SYNCPEER_LAN_SELF === "1") {
      await reportPhase("global", "skipped", {
        reason: "self mode has one network namespace; run two-host E2E for public discovery",
      });
      this.skip();
      return;
    }
    await runPhase("global", async () => {
      await disconnect();
      await connect(currentFixture, "global");
    });
  });

  it("falls back through the standard relay pool", async function () {
    if (process.env.SYNCPEER_LAN_SELF === "1") {
      await reportPhase("relay", "skipped", {
        reason: "self mode has one network namespace; run two-host E2E for relay transport",
      });
      this.skip();
      return;
    }
    await runPhase("relay", async () => {
      await request("POST", "/v1/action", { action: "switch-to-relay" });
      await disconnect();
      await connect(currentFixture, "global");
      await waitForText(lanBrowser, "Path: relay", 60_000);
    });
  });

  it("browses and downloads a receive-encrypted folder", async () => {
    await runPhase("encrypted-direct", async () => {
      assert.ok(untrustedIdentity.deviceId && untrustedIdentity.cert && untrustedIdentity.key);
      if (process.env.SYNCPEER_LAN_MANUAL_IDS !== "1") {
        await request("POST", "/v1/action", {
          action: "add-untrusted",
          details: { deviceId: untrustedIdentity.deviceId },
        });
        await request("POST", "/v1/register", {
          profile: "untrusted",
          deviceId: untrustedIdentity.deviceId,
        });
      }
      await disconnect();
      await connect(currentFixture, "direct", untrustedIdentity);
      await openFolders();
      await waitForText(lanBrowser, currentFixture.encryptedFolderId, 90_000);
      const passwordInput = $("[data-testid='folder-password-" + currentFixture.encryptedFolderId + "']");
      if (!(await passwordInput.isExisting())) {
        await clickTestId("edit-folder-password-" + currentFixture.encryptedFolderId);
      }
      await setValue(`folder-password-${currentFixture.encryptedFolderId}`, currentFixture.encryptedPassword);
      await clickTestId(`unlock-folder-${currentFixture.encryptedFolderId}`);
      await waitForText(lanBrowser, "unlocked", 90_000).catch(async (error) => {
        console.log(`Safe session events: ${(await readSessionEventNames(lanBrowser)).join(", ")}`);
        throw error;
      });
      await clickItemTitle(lanBrowser, currentFixture.encryptedFolderId);
      await waitForText(lanBrowser, "secret.txt", 90_000);
      await downloadByName("secret.txt");
      assert.equal(
        await readCachedHash(lanBrowser, "secret.txt"),
        currentFixture.encryptedExpected.sha256,
      );
    });
  });

  it("reports public discovery reachability without gating the LAN run", async () => {
    await reportPhase("public-smoke", "running");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const discoveryUrl = new URL(currentFixture.discoveryServer);
      discoveryUrl.searchParams.set("device", currentFixture.remoteDeviceId);
      const response = await fetch(
        discoveryUrl,
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
