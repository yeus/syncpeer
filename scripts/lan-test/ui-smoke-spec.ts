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
  const source = await tauriBrowser.getPageSource();
  console.log(
    "UI connection state: " +
    JSON.stringify({
      connected: (await $("[data-testid='global-connect-button']").getText()).trim() === "Disconnect",
      relayPathRendered: source.includes("Path: relay"),
      directPathRendered: source.includes("Path: direct tcp"),
    }),
  );
};

const returnToFolderRoot = async (): Promise<void> => {
  const rootButton = $("button.crumb-button");
  if (!(await rootButton.isExisting())) return;
  await tauriBrowser.execute(() => {
    (document.querySelector("button.crumb-button") as HTMLElement | null)?.click();
  });
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
      await waitForText(tauriBrowser, LAN_FIXTURE_FOLDER_ID, 90_000);
      await clickItemTitle(tauriBrowser, LAN_FIXTURE_FOLDER_ID);
      try {
        await waitForText(tauriBrowser, "hello.txt", folderWaitTimeout());
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
      await clickDownloadButton(tauriBrowser, "hello.txt");
      try {
        await waitForText(tauriBrowser, "Downloaded hello.txt", 90_000);
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
      assert.match(
        await tauriBrowser.getPageSource(),
        /Downloaded hello\.txt via (direct|relay)/,
      );
      assert.equal(
        await readCachedHash(tauriBrowser, "hello.txt"),
        createHash("sha256").update(LAN_FIXTURE_HELLO_CONTENT).digest("hex"),
      );

      await clickDownloadButton(tauriBrowser, "blob.bin");
      await waitForText(tauriBrowser, "Downloaded blob.bin", 180_000);
      assert.match(
        await tauriBrowser.getPageSource(),
        /Downloaded blob\.bin via (direct|relay)/,
      );

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
        await waitForText(tauriBrowser, LAN_FIXTURE_FOLDER_ID, folderWaitTimeout());
        await clickItemTitle(tauriBrowser, LAN_FIXTURE_FOLDER_ID);
        await waitForText(tauriBrowser, "hello.txt", folderWaitTimeout());

        await tauriBrowser.execute(() => {
          window.dispatchEvent(new Event("focus"));
          window.dispatchEvent(new Event("pageshow"));
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await clickTestId("tab-devices");
        await waitForText(tauriBrowser, "This Device");
        await clickTestId("tab-folders");
        await returnToFolderRoot();
        await waitForText(tauriBrowser, LAN_FIXTURE_FOLDER_ID, folderWaitTimeout());
        await clickItemTitle(tauriBrowser, LAN_FIXTURE_FOLDER_ID);
        await waitForText(tauriBrowser, "hello.txt", folderWaitTimeout());
        console.log(`Foreground folder refresh ${attempt} passed.`);
      }
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
