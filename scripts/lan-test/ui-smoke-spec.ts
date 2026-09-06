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
  setAutomaticConnectionPaused,
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
const uiStateStorageKey = "syncpeer.ui.state.v1";
const syntheticDeviceId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const syntheticFolderId = "synthetic-encrypted-folder";

const syntheticDirectoryEntries = () => [
  {
    name: "nested",
    path: "nested",
    type: "directory",
    size: 0,
    modifiedMs: 1_800_000_000_000,
    invalid: false,
    stats: {
      fileCount: 3,
      directoryCount: 1,
      symlinkCount: 0,
      invalidCount: 1,
      totalBytes: 25,
      indexReceived: true,
    },
  },
  ...Array.from({ length: 80 }, (_, index) => ({
    name: `fixture-${String(index + 1).padStart(2, "0")}.txt`,
    path: `fixture-${String(index + 1).padStart(2, "0")}.txt`,
    type: "file",
    size: 1024 + index,
    modifiedMs: 1_800_000_000_000 + index,
    invalid: false,
  })),
];

const seedOfflineFolderState = async (): Promise<void> => {
  const activeDirectoryKey = JSON.stringify([syntheticFolderId, ""]);
  await tauriBrowser.execute(
    (storageKey: string, deviceId: string, folderId: string, directoryKey: string, entries) => {
      localStorage.setItem(storageKey, JSON.stringify({
        activeTab: "folders",
        selectedSavedDeviceId: "",
        connection: {
          host: "",
          port: 22000,
          cert: "",
          key: "",
          remoteId: "",
          deviceName: "syncpeer-ui-e2e",
          timeoutMs: 15000,
          discoveryMode: "automatic",
          discoveryServer: "https://discovery.syncthing.net/v2/",
          enableRelayFallback: true,
          autoAcceptNewDevices: false,
          autoAcceptIntroducedFolders: false,
        },
        savedDevices: [],
        folderPasswords: { [`${deviceId}:${folderId}`]: "synthetic-password" },
        offlineFolderSnapshots: {
          [deviceId]: {
            deviceId,
            remoteDevice: { id: deviceId, deviceName: "Synthetic peer" },
            folders: [{
              id: folderId,
              label: "Synthetic encrypted folder",
              readOnly: false,
              encrypted: true,
              needsPassword: false,
              passwordError: null,
            }],
            folderSyncStates: [],
            connectedVia: "offline fixture",
            transportKind: "direct-tcp",
            connectionScope: "lan",
            directories: {
              [directoryKey]: {
                folderId,
                path: "",
                entries,
                versionKey: "synthetic-version",
                loadedAtMs: Date.now(),
              },
            },
            activeDirectoryKey: directoryKey,
            lastSeenAtMs: Date.now(),
          },
        },
        directoryViewMode: "list",
        directorySortMode: "name",
        theme: { mode: "dark", primary: "#2a3548", secondary: "#f78f3b" },
      }));
    },
    uiStateStorageKey,
    syntheticDeviceId,
    syntheticFolderId,
    activeDirectoryKey,
    syntheticDirectoryEntries(),
  );
  await tauriBrowser.refresh();
};

const clearSeededOfflineFolderState = async (): Promise<void> => {
  await tauriBrowser.execute((storageKey: string) => localStorage.removeItem(storageKey), uiStateStorageKey);
  await tauriBrowser.refresh();
};

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
  const status = $("[data-testid='connection-status']");
  if ((await status.getText()).trim() !== "Connected") return;
  await setAutomaticConnectionPaused(tauriBrowser, true);
  await waitForDisconnected(tauriBrowser);
};

const connectToServer = async (): Promise<void> => {
  await disconnectIfConnected();
  await configureGlobalConnection();
  await connectUntilApproved(tauriBrowser);
  const statusText = (await $("[data-testid='connection-status']").getText())
    .replace(/\s+/g, " ")
    .trim();
  const disclosure = $("[data-testid='connection-status-toggle']");
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const connectionDetails = (await $("[data-testid='connection-details']").getText())
    .replace(/\s+/g, " ")
    .trim();
  console.log(
    "UI connection state: " +
    JSON.stringify({
      connected: (await $("[data-testid='connection-status']").getText()).trim() === "Connected",
      statusText,
      connectionDetails,
    }),
  );
  assert.equal(statusText, "Connected");
  assert.match(connectionDetails, /Path:/);
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

  it("applies light, dark, automatic, and custom theme settings", async () => {
    await clickTestId("tab-devices");
    await openConnectionSettings();
    const setThemeMode = async (mode: "auto" | "light" | "dark") => {
      await tauriBrowser.execute((nextMode: string) => {
        const select = document.querySelector("[data-testid='theme-mode']") as HTMLSelectElement;
        select.value = nextMode;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, mode);
      await tauriBrowser.waitUntil(
        async () => await tauriBrowser.execute(
          (expected: string) => document.documentElement.dataset.theme === expected,
          mode === "auto"
            ? await tauriBrowser.execute(() => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
            : mode,
        ),
        { timeout: 5_000, timeoutMsg: `Theme ${mode} was not applied.` },
      );
    };
    await setThemeMode("light");
    const lightBackground = await tauriBrowser.execute(() => getComputedStyle(document.body).backgroundColor);
    await setThemeMode("dark");
    const darkBackground = await tauriBrowser.execute(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(lightBackground, darkBackground);
    await tauriBrowser.execute(() => {
      const primary = document.querySelector("[data-testid='theme-primary-color']") as HTMLInputElement;
      const secondary = document.querySelector("[data-testid='theme-secondary-color']") as HTMLInputElement;
      primary.value = "#123456";
      primary.dispatchEvent(new Event("input", { bubbles: true }));
      secondary.value = "#abcdef";
      secondary.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const colors = await tauriBrowser.execute(() => {
      const style = getComputedStyle(document.documentElement);
      return [
        style.getPropertyValue("--brand-primary").trim(),
        style.getPropertyValue("--brand-secondary").trim(),
      ];
    });
    assert.deepEqual(colors.map((color) => color.toUpperCase()), ["#123456", "#ABCDEF"]);
    await setThemeMode("auto");
  });

  it("keeps connection state in the header and reveals details on demand", async () => {
    const status = $("[data-testid='connection-status']");
    const disclosure = $("[data-testid='connection-status-toggle']");
    await status.waitForExist({ timeout: 10_000 });
    assert.equal(await $("[data-testid='global-connect-button']").isExisting(), false);
    if (await disclosure.getAttribute("aria-expanded") === "true") await disclosure.click();
    assert.equal(await $("[data-testid='connection-details']").isExisting(), false);
    await disclosure.click();
    await $("[data-testid='connection-details']").waitForExist({ timeout: 5_000 });
    assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
  });

  it("resets folder scroll when returning to a password-backed folder view", async () => {
    await seedOfflineFolderState();
    try {
      await $(`[data-testid='folder-name-filter']`).waitForExist({ timeout: 10_000 });
      const nestedFolder = await $(`[data-testid='folder-entry-nested']`);
      assert.include(await nestedFolder.getText(), "3 files | 25 B | 1 folder");
      await tauriBrowser.execute(() => {
        const content = document.querySelector("[data-testid='app-content']") as HTMLElement | null;
        if (!content) throw new Error("App content container is not mounted.");
        content.scrollTop = 96;
      });
      await clickTestId("tab-devices");
      await clickTestId("tab-folders");
      await tauriBrowser.waitUntil(
        async () => await tauriBrowser.execute(() => {
          const content = document.querySelector("[data-testid='app-content']") as HTMLElement | null;
          return content?.scrollTop === 0;
        }),
        {
          timeout: 5_000,
          timeoutMsg: "Folder content did not reset to the top after tab navigation.",
        },
      );
      const geometry = await tauriBrowser.execute(() => {
        const header = document.querySelector(".app-header")?.getBoundingClientRect();
        const tools = document.querySelector(".directory-tools")?.getBoundingClientRect();
        if (!header || !tools) throw new Error("Folder geometry targets are not mounted.");
        return { headerBottom: header.bottom, toolsTop: tools.top };
      });
      assert.ok(
        geometry.toolsTop >= geometry.headerBottom,
        `Folder controls overlap the app header: ${JSON.stringify(geometry)}`,
      );
    } finally {
      await clearSeededOfflineFolderState();
    }
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
    await $("[data-testid='connection-status-toggle']").waitForExist({ timeout: 10_000 });
  });

  it("marks PIM sync as experimental and disabled by default", async () => {
    await clickTestId("tab-pim");
    const notice = $("[data-testid='pim-experimental-notice']");
    await notice.waitForExist({ timeout: 10_000 });
    assert.match(await notice.getText(), /experimental/i);
    assert.equal(await $("[data-testid='pim-enabled']").isSelected(), false);
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
    await $("[data-testid='connection-status-toggle']").waitForExist({ timeout: 10_000 });
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
      await clickTestId("tab-folders");
      await waitForText(tauriBrowser, "Offline · last seen", 5_000);
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
