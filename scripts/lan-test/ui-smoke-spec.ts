import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { browser, $ } from "@wdio/globals";
import {
  LAN_FIXTURE_FOLDER_ID,
  LAN_FIXTURE_HELLO_CONTENT,
} from "./fixture-data.ts";
import { normalizeDiscoveryServer } from "../../packages/core/src/ui/discoveryServer.ts";
import {
  clickDownloadButton,
  clickItemTitle,
  connectUntilApproved,
  readCachedHash,
  selectDiscoveryMode,
  setUploadFile,
  setValue,
  waitForDisconnected,
  type TauriBrowser,
  waitForText,
} from "./ui-helpers.ts";

const tauriBrowser = browser as unknown as TauriBrowser;
const serverDeviceId = process.env.SYNCPEER_DEV_SERVER_DEVICE_ID?.trim() ?? "";
const discoveryServer = (): string =>
  normalizeDiscoveryServer(process.env.SYNCPEER_LAN_DISCOVERY_SERVER?.trim());
const connectionTimeout = (): string =>
  process.env.SYNCPEER_LAN_TIMEOUT_MS?.trim() || "120000";
const folderWaitTimeout = (): number =>
  Number(process.env.SYNCPEER_LAN_FOLDER_WAIT_MS?.trim() || 90_000);
const targetFolderId = process.env.SYNCPEER_E2E_FOLDER_ID?.trim() ||
  LAN_FIXTURE_FOLDER_ID;
const targetFolderTitle = process.env.SYNCPEER_E2E_FOLDER_TITLE?.trim() ||
  targetFolderId;
const targetFileName = process.env.SYNCPEER_E2E_FILE_NAME?.trim() || "hello.txt";
const targetFolderPassword = process.env.SYNCPEER_E2E_FOLDER_PASSWORD?.trim() || "";
const targetFileSha256 = process.env.SYNCPEER_E2E_FILE_SHA256?.trim() ||
  createHash("sha256").update(LAN_FIXTURE_HELLO_CONTENT).digest("hex");
const targetLargeFileName = process.env.SYNCPEER_E2E_LARGE_FILE_NAME === undefined
  ? "blob.bin"
  : process.env.SYNCPEER_E2E_LARGE_FILE_NAME.trim();

const nativeDiscoveryRequest = (): { url: string; method: string; headers: Record<string, string>; pinServerDeviceId: string | null; allowInsecureTls: boolean } => {
  const url = new URL(discoveryServer());
  const pinServerDeviceId = url.searchParams.get("id");
  const allowInsecureTls = url.searchParams.has("insecure");
  url.searchParams.delete("id");
  url.searchParams.delete("insecure");
  url.searchParams.set("device", serverDeviceId);
  return {
    url: url.toString(),
    method: "GET",
    headers: { Accept: "application/json" },
    pinServerDeviceId,
    allowInsecureTls,
  };
};

if (!serverDeviceId) throw new Error("SYNCPEER_DEV_SERVER_DEVICE_ID is missing.");

const clickTestId = async (testId: string): Promise<void> => {
  const element = $(`[data-testid='${testId}']`);
  await element.waitForExist();
  await tauriBrowser.execute((id: string) => {
    const button = document.querySelector(`[data-testid='${id}']`) as HTMLElement | null;
    button?.click();
  }, testId);
};

const openConnectionSettings = async (): Promise<void> => {
  const settings = $("[data-testid='connection-settings-toggle']");
  const mode = $("[data-testid='connection-discovery-mode']");
  if (
    await settings.getAttribute("aria-expanded") !== "true" &&
    !(await mode.isExisting())
  ) {
    await tauriBrowser.execute(() => {
      const button = document.querySelector(
        "[data-testid='connection-settings-toggle']",
      ) as HTMLButtonElement | null;
      button?.click();
    });
  }
  await tauriBrowser.waitUntil(
    async () => {
      if (await mode.isExisting()) return true;
      return mode.isExisting();
    },
    {
      timeout: 5_000,
      timeoutMsg: "Timed out waiting for connection settings to render.",
    },
  );
};

const configureGlobalConnection = async (): Promise<void> => {
  await clickTestId("tab-devices");
  await openConnectionSettings();
  await selectDiscoveryMode(tauriBrowser, "global");
  await setValue("connection-discovery-server", discoveryServer());
  await setValue("connection-remote-id", serverDeviceId);
  await setValue("connection-timeout", connectionTimeout());
  console.log(
    "UI connection settings: " +
    JSON.stringify({
      discoveryServer: await $("[data-testid='connection-discovery-server']").getValue(),
      remoteId: await $("[data-testid='connection-remote-id']").getValue(),
      timeoutMs: await $("[data-testid='connection-timeout']").getValue(),
    }),
  );
};

const disconnectIfConnected = async (): Promise<void> => {
  const button = $("[data-testid='global-connect-button']");
  if ((await button.getText()).trim() !== "Disconnect") return;
  await button.click();
  await waitForDisconnected(tauriBrowser);
};

const connectToServer = async (): Promise<void> => {
  await disconnectIfConnected();
  await configureGlobalConnection();
  await connectUntilApproved(tauriBrowser);
  const statusText = (await $("[data-testid='connection-status']").getText())
    .replace(/\s+/g, " ")
    .trim();
  console.log(
    "UI connection state: " +
    JSON.stringify({
      connected: (await $("[data-testid='global-connect-button']").getText()).trim() === "Disconnect",
      statusText,
    }),
  );
  assert.match(statusText, /Path: (direct|relay) · (LAN|WAN|unknown)/);
};

const returnToFolderRoot = async (): Promise<void> => {
  const rootButton = $("button.crumb-button");
  if (!(await rootButton.isExisting())) return;
  await tauriBrowser.execute(() => {
    (document.querySelector("button.crumb-button") as HTMLElement | null)?.click();
  });
};

const unlockTargetFolder = async (): Promise<void> => {
  if (!targetFolderPassword) return;
  const editButton = $(`[data-testid='edit-folder-password-${targetFolderId}']`);
  const passwordInput = $(`[data-testid='folder-password-${targetFolderId}']`);
  if (!(await passwordInput.isExisting()) && !(await editButton.isExisting())) return;
  if (await editButton.isExisting()) {
    await editButton.click();
    await passwordInput.waitForExist({ timeout: 5_000 });
  }
  await setValue(`folder-password-${targetFolderId}`, targetFolderPassword);
  await clickTestId(`unlock-folder-${targetFolderId}`);
};

describe("Syncpeer Tauri UI smoke", () => {
  it("renders the native identity and connection mode controls", async () => {
    await clickTestId("tab-devices");
    const currentDeviceId = $("[data-testid='current-device-id']");
    await currentDeviceId.waitForExist({ timeout: 60_000 });
    const deviceId = await currentDeviceId.getText();
    assert.match(deviceId, /^[A-Z2-7-]{40,}$/);
    console.log("\nSyncpeer UI client device ID: " + deviceId);
    console.log("Approve this pending device in the server terminal.\n");

    await clickTestId("tab-devices");
    await openConnectionSettings();
    await selectDiscoveryMode(tauriBrowser, "lan");
    await waitForText(tauriBrowser, "LAN discovery uses Syncthing's local UDP discovery.");
    await selectDiscoveryMode(tauriBrowser, "direct");
    await waitForText(tauriBrowser, "Host");
    await selectDiscoveryMode(tauriBrowser, "global");
    await waitForText(tauriBrowser, "Global discovery ignores manual host/port.");
  });

  it("reaches the configured discovery server through Tauri", async () => {
    const payload = await tauriBrowser.tauri.execute((tauri, request) =>
      tauri.core.invoke("syncpeer_discovery_fetch", { request }),
      nativeDiscoveryRequest(),
    ) as { status: number; body: string };
    console.log("Native discovery response: " + payload.status + " " + payload.body.slice(0, 300));
    assert.equal(payload.status, 200);
  });

  it("connects through the live server and disconnects cleanly", async () => {
    await connectToServer();
    await disconnectIfConnected();
  });

  it("reconnects through the live server", async () => {
    await connectToServer();
    await disconnectIfConnected();
    await connectToServer();
    await disconnectIfConnected();
  });

  it("shows reproducible build and runtime metadata in About", async () => {
    await clickTestId("tab-devices");
    const aboutButton = $("[data-testid='open-about']");
    await aboutButton.waitForExist({ timeout: 10_000 });
    await aboutButton.click();
    await $("[data-testid='about-page']").waitForExist({ timeout: 10_000 });
    assert.match(await $("[data-testid='about-version']").getText(), /.+/);
    assert.match(await $("[data-testid='about-commit']").getText(), /[0-9a-f]{8,}|unknown/i);
    assert.match(await $("[data-testid='about-runtime']").getText(), /\//);
    assert.match(await $("[data-testid='about-support-summary']").getValue(), /build_commit:/);
    await $("[data-testid='about-copy']").click();
    await $("[data-testid='about-copy-notice']").waitForExist({ timeout: 5_000 });
    await $("[data-testid='about-back']").click();
    await $("[data-testid='global-connect-button']").waitForExist({ timeout: 10_000 });
  });

  it("runs all registered diagnostics through the Tauri UI", async () => {
    await clickTestId("tab-devices");
    const diagnosticsButton = $("[data-testid='open-diagnostics']");
    await diagnosticsButton.waitForExist({ timeout: 10_000 });
    await diagnosticsButton.click();
    const runAll = $("[data-testid='diagnostics-run-all']");
    const result = $("[data-testid='diagnostics-result']");
    await runAll.waitForExist({ timeout: 10_000 });
    await runAll.click();
    await tauriBrowser.waitUntil(
      async () => (await result.getValue()).includes('"allPassed": true'),
      {
        timeout: 180_000,
        timeoutMsg: "The in-app diagnostics suite did not pass.",
      },
    );
    assert.match(String(await result.getValue()), /"allPassed": true/);
    assert.match(String(await result.getValue()), /"buildInfo":/);
    await $("[data-testid='diagnostics-back']").click();
    await $("[data-testid='global-connect-button']").waitForExist({ timeout: 10_000 });
  });

  it("browses a remote folder and downloads through the Tauri cache", async () => {
    await tauriBrowser.tauri.execute((tauri) =>
      tauri.core.invoke("syncpeer_clear_cache"),
    );
    await connectToServer();
    try {
      await clickTestId("tab-folders");
      await returnToFolderRoot();
      await waitForText(tauriBrowser, targetFolderTitle, 90_000);
      await unlockTargetFolder();
      await clickItemTitle(tauriBrowser, targetFolderTitle);
      try {
        await waitForText(tauriBrowser, targetFileName, folderWaitTimeout());
      } catch (error) {
        await clickTestId("tab-devices");
        await tauriBrowser.pause(500);
        const logs = await tauriBrowser.execute(() =>
          [...document.querySelectorAll(".item-meta")]
            .map((element) => element.textContent?.trim() ?? "")
            .filter(Boolean)
            .slice(0, 120),
        );
        console.log("UI session logs after hello.txt timeout:\n" + logs.join("\n---\n"));
        const handshakeLogs = await tauriBrowser.execute(() =>
          [...document.querySelectorAll(".item-meta")]
            .map((element) => element.textContent?.trim() ?? "")
            .filter((text) => text.includes("core.bep.handshake.peer_cert")),
        );
        console.log("UI handshake identity logs:\n" + handshakeLogs.join("\n---\n"));
        throw error;
      }
      await clickDownloadButton(tauriBrowser, targetFileName);
      try {
        await waitForText(tauriBrowser, `Downloaded ${targetFileName}`, 90_000);
      } catch (error) {
        await clickTestId("tab-devices");
        await tauriBrowser.pause(500);
        const logs = await tauriBrowser.execute(() =>
          [...document.querySelectorAll(".item-meta")]
            .map((element) => element.textContent?.trim() ?? "")
            .filter(Boolean)
            .slice(-120),
        );
        console.log("UI session logs after hello.txt download timeout:\n" + logs.join("\n---\n"));
        throw error;
      }
      assert.ok(
        (await tauriBrowser.getPageSource())
          .replace(/\s+/g, " ")
          .includes(`Downloaded ${targetFileName} via relay · WAN`),
      );
      assert.equal(
        await readCachedHash(tauriBrowser, targetFileName),
        targetFileSha256,
      );

      if (targetLargeFileName) {
        await clickDownloadButton(tauriBrowser, targetLargeFileName);
        await waitForText(
          tauriBrowser,
          `Downloaded ${targetLargeFileName}`,
          180_000,
        );
      }

      const clientRoot = process.env.SYNCPEER_LAN_CLIENT_ROOT ?? path.resolve(".tmp/syncpeer-dev-client");
      const uploadName = `ui-upload-${Date.now()}.txt`;
      const uploadPath = path.join(clientRoot, uploadName);
      fs.mkdirSync(clientRoot, { recursive: true });
      fs.writeFileSync(uploadPath, "uploaded from the Syncpeer Tauri UI\n", "utf8");
      await setUploadFile(tauriBrowser, uploadPath);
      await waitForText(tauriBrowser, `Uploaded ${uploadName}.`, 90_000);
    } finally {
      await disconnectIfConnected();
    }
  });

  it("keeps folders and directory entries after foreground refreshes", async () => {
    await connectToServer();
    try {
      await clickTestId("tab-folders");
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await returnToFolderRoot();
        await waitForText(tauriBrowser, targetFolderTitle, folderWaitTimeout());
        await unlockTargetFolder();
        await clickItemTitle(tauriBrowser, targetFolderTitle);
        await waitForText(tauriBrowser, targetFileName, folderWaitTimeout());

        await tauriBrowser.execute(() => {
          window.dispatchEvent(new Event("focus"));
          window.dispatchEvent(new Event("pageshow"));
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await clickTestId("tab-devices");
        await waitForText(tauriBrowser, "This Device");
        await clickTestId("tab-folders");
        await returnToFolderRoot();
        await waitForText(tauriBrowser, targetFolderTitle, folderWaitTimeout());
        await unlockTargetFolder();
        await clickItemTitle(tauriBrowser, targetFolderTitle);
        await waitForText(tauriBrowser, targetFileName, folderWaitTimeout());
        console.log(`Foreground folder refresh ${attempt} passed.`);
      }
    } finally {
      await disconnectIfConnected();
    }
  });

  it("keeps the last browsed folders and files while disconnected", async () => {
    await connectToServer();
    try {
      await clickTestId("tab-folders");
      await returnToFolderRoot();
      await waitForText(tauriBrowser, targetFolderTitle, folderWaitTimeout());
      await unlockTargetFolder();
      await clickItemTitle(tauriBrowser, targetFolderTitle);
      await waitForText(tauriBrowser, targetFileName, folderWaitTimeout());
      assert.match(
        await $("[data-testid='folder-view-status']").getText(),
        /Live · in sync/,
      );

      await disconnectIfConnected();
      await waitForText(tauriBrowser, targetFileName, 5_000);
      assert.match(
        await $("[data-testid='folder-view-status']").getText(),
        /Offline · last seen/,
      );
      await returnToFolderRoot();
      await waitForText(tauriBrowser, targetFolderTitle, 5_000);
      await clickItemTitle(tauriBrowser, targetFolderTitle);
      await waitForText(tauriBrowser, targetFileName, 5_000);
    } finally {
      await disconnectIfConnected();
    }
  });

  it("opens the discovered relay through Tauri", async () => {
    const discovery = await tauriBrowser.tauri.execute((tauri, request) =>
      tauri.core.invoke("syncpeer_discovery_fetch", { request }),
      nativeDiscoveryRequest(),
    ) as { status: number; body: string };
    assert.equal(discovery.status, 200);
    const relayAddresses = (JSON.parse(discovery.body) as { addresses?: string[] }).addresses
      ?.filter((address) => address.startsWith("relay://")) ?? [];
    assert.ok(relayAddresses.length > 0, "Discovery response did not contain a relay address.");
    const identity = await tauriBrowser.tauri.execute((tauri) =>
      tauri.core.invoke("syncpeer_read_default_cli_identity"),
    ) as { certPem: string; keyPem: string };
    const failures: string[] = [];
    for (const relayAddress of relayAddresses) {
      try {
        const opened = await tauriBrowser.tauri.execute((tauri, request) =>
          tauri.core.invoke("syncpeer_relay_open", { request }),
          {
            relayAddress,
            expectedDeviceId: serverDeviceId,
            certPem: identity.certPem,
            keyPem: identity.keyPem,
            caPem: null,
            timeoutMs: Number(connectionTimeout()),
          },
        ) as { sessionId: number; peerCertificateDer: number[] };
        console.log("Native relay session opened: " + opened.sessionId);
        await tauriBrowser.tauri.execute((tauri, sessionId: number) =>
          tauri.core.invoke("syncpeer_tls_close", { request: { sessionId } }),
          opened.sessionId,
        );
        assert.ok(opened.peerCertificateDer.length > 0);
        return;
      } catch (error) {
        failures.push(`${relayAddress}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`All discovered relay candidates failed:\n${failures.join("\n")}`);
  });
});
