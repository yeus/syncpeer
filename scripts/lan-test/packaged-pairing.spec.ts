// code-analysis-disable lines -- Packaged two-app E2E harness; scenario steps and session-log instrumentation are kept together for readability.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { browser } from "@wdio/globals";
import type * as Tauri from "@tauri-apps/api";
import { preferredPeerDirection } from "../../packages/core/src/sync/peerSessionManager.js";
import { createFreshEncryptedProfile } from "./profile-setup.js";
import {
  openGeneralSettings,
  openFolderSettings,
  clickButtonByText,
  setAutomaticConnectionPaused,
  setDirectConnectionFields,
  setUploadBytes,
} from "./ui-helpers.js";
const peers = () =>
  browser as typeof browser & {
    owner: WebdriverIO.Browser;
    joiner: WebdriverIO.Browser;
  };
const folderName = "Synthetic desktop folder";

const screenshotDir = process.env.SYNCPEER_SCREENSHOT_DIR?.trim();

async function focusPeer(peer: WebdriverIO.Browser) {
  await peer.execute(async () => {
    const tauri = (window as typeof window & {
      __TAURI__: typeof Tauri;
    }).__TAURI__;
    await tauri.window.getCurrentWindow().setFocus();
  });
  await peer.waitUntil(() => peer.execute(() => document.hasFocus()), {
    timeout: 5_000,
    timeoutMsg: "The target desktop window did not gain focus.",
  });
}

async function captureScreenshot(peer: WebdriverIO.Browser, name: string) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  console.log(`Packaged screenshots: capturing ${name}.`);
  // Capture the requested app, not whichever isolated peer last had focus.
  await focusPeer(peer);
  console.log(`Packaged screenshots: focused ${name}.`);
  const destination = path.join(screenshotDir, `syncpeer-${name}.png`);
  const result = spawnSync("scrot", ["-u", destination], { stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "The focused desktop window screenshot failed.");
  console.log(`Packaged screenshots: captured ${name}.`);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function configureConnection(
  peer: WebdriverIO.Browser,
  remoteId: string,
  remotePort: number,
  localPort: number,
) {
  await setAutomaticConnectionPaused(peer, true);
  await setDirectConnectionFields(peer, {
    remoteId,
    host: "127.0.0.1",
    remotePort,
    listenPort: localPort,
  });
  await peer
    .$("[data-testid='connection-direct-quic']")
    .waitForExist({ timeout: 5_000 });
  assert.equal(
    await peer.$("[data-testid='connection-remote-id']").getValue(),
    remoteId,
  );
  assert.equal(
    await peer.$("[data-testid='connection-host']").getValue(),
    "127.0.0.1",
  );
  assert.equal(
    await peer.$("[data-testid='connection-discovery-mode']").getValue(),
    "direct",
  );
  assert.equal(
    await peer.$("[data-testid='connection-port']").getValue(),
    String(remotePort),
  );
  assert.equal(
    await peer.$("[data-testid='connection-listen-port']").getValue(),
    String(localPort),
  );
  await peer.pause(750);
  assert.equal(
    await peer.$("[data-testid='connection-port']").getValue(),
    String(remotePort),
  );
  assert.equal(
    await peer.$("[data-testid='connection-listen-port']").getValue(),
    String(localPort),
  );
}

async function openFolder(peer: WebdriverIO.Browser, name: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await peer.$("[data-testid='tab-folders']").click();
    const row = peer.$(
      `//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(name)}]`,
    );
    await row.waitForExist({ timeout: 30_000 });
    const action = row.$(
      "./ancestor::li[1]//*[contains(@class,'item-main-hit-clickable')]",
    );
    await action.waitForExist({
      timeout: 30_000,
      timeoutMsg:
        "The shared folder is listed but cannot be opened with its approved credential.",
    });
    await action.click();
    try {
      await peer.$("#folder-upload-input").waitForExist({ timeout: 10_000 });
      return;
    } catch (error) {
      lastError = error;
      await peer.pause(1_000);
    }
  }
  const state = await peer.execute(() => ({
    status:
      document
        .querySelector("[data-testid='connection-status']")
        ?.textContent?.trim() ?? "missing",
    notice:
      document
        .querySelector("[data-testid='folder-root-empty-notice']")
        ?.textContent?.trim() ?? "none",
    folderView:
      document
        .querySelector("[data-testid='folder-view-status']")
        ?.textContent?.trim() ?? "missing",
    visibleAlerts: [...document.querySelectorAll("p[role='alert']")].map(
      (value) => value.textContent?.trim(),
    ),
    visibleErrors: [...document.querySelectorAll("p.error, li.empty")]
      .map((value) => value.textContent?.trim())
      .filter(Boolean)
      .slice(-4),
    events:
      (
        window as typeof window & { __syntheticEvents?: string[] }
      ).__syntheticEvents?.slice(-30) ?? [],
    failures:
      (window as typeof window & { __syntheticFailures?: string[] })
        .__syntheticFailures ?? [],
  }));
  throw new Error(
    `The folder did not open after three attempts: ${JSON.stringify(state)}`,
    { cause: lastError },
  );
}

async function uploadFile(
  peer: WebdriverIO.Browser,
  name: string,
  content: string,
) {
  await setUploadBytes(peer, name, new TextEncoder().encode(content));
  await peer.pause(250);
  const immediateState = await peer.execute(() => ({
    hints: [...document.querySelectorAll(".hint, p.error")]
      .map((element) => element.textContent?.trim())
      .filter(Boolean)
      .slice(-8),
    progressVisible: Boolean(document.querySelector(".upload-progress-wrap")),
  }));
  try {
    await peer
      .$(
        `//*[contains(@class,'hint') and normalize-space()=${JSON.stringify(`Uploaded ${name}.`)}]`,
      )
      .waitForExist({ timeout: 30_000 });
  } catch (error) {
    const diagnostics = await peer.execute((immediateState) => {
      const logs = [...document.querySelectorAll("ul.list > li")]
        .map((item) => ({
          event:
            item
              .querySelector(".item-meta")
              ?.textContent?.split(" | ")
              .at(-1)
              ?.trim() ?? "",
          details:
            item.querySelector("pre.log-details")?.textContent?.trim() ?? "",
        }))
        .filter((item) =>
          /^(upload[._]|starred\.|client\.|core\.)/.test(item.event),
        )
        .slice(-40);
      const observed = window as typeof window & {
        __syntheticEvents?: string[];
        __syntheticFailures?: string[];
        __syntheticIndexes?: string[];
        __syntheticReplicaStates?: string[];
        __syncpeerStateProbe?: () => unknown;
        __syncpeerStoreStateProbe?: () => unknown;
      };      return {
        immediateState,
        state: observed.__syncpeerStateProbe?.() ?? null,
        storeState: observed.__syncpeerStoreStateProbe?.() ?? null,
        hints: [...document.querySelectorAll(".hint, p.error")]          .map((element) => element.textContent?.trim())
          .filter(Boolean)
          .slice(-8),
        connection:
          document
            .querySelector("[data-testid='connection-status']")
            ?.textContent?.trim() ?? "missing",
        events: observed.__syntheticEvents?.slice(-60) ?? [],
        failures: observed.__syntheticFailures?.slice(-20) ?? [],
        indexes: observed.__syntheticIndexes?.slice(-20) ?? [],
        replicas: observed.__syntheticReplicaStates?.slice(-20) ?? [],
        entries: [...document.querySelectorAll(".item-title")]
          .map((value) => value.textContent?.trim())
          .filter(Boolean)
          .slice(-20),
        logs,
      };
    }, immediateState);
    throw new Error(
      `Packaged upload did not complete: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
}

async function waitForFile(peer: WebdriverIO.Browser, name: string) {
  await peer
    .$(
      `//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(name)}]`,
    )
    .waitForExist({ timeout: 120_000 });
}

async function waitForSessionFolder(
  peer: WebdriverIO.Browser,
  name: string,
  timeoutMsg: string,
) {
  await peer.waitUntil(
    async () => {
      const connected = (await peer.$("[data-testid='connection-status']").getText())
        .includes("Connected");
      if (!connected) return false;
      return peer.execute(folderName => {
        const title = [...document.querySelectorAll(".item-title")]
          .find(element => element.textContent?.trim() === folderName);
        const row = title?.closest("[data-testid^='folder-root-']");
        return Boolean(row && /receive-encrypted\s*\|\s*unlocked/i.test(row.textContent ?? ""));
      }, name);
    },
    { timeout: 120_000, timeoutMsg },
  );
}

async function acceptPendingApproval(peer: WebdriverIO.Browser) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = await peer.getAlertText().catch(() => "");
    if (!message) return;
    if (message === "Name this Syncpeer client (shown to remote devices):") {
      await peer.sendAlertText("synthetic-packaged-peer");
      await peer.acceptAlert();
      continue;
    }
    assert.match(message, /Confirm that both devices display pairing code/);
    await peer.acceptAlert();
  }
}

async function captureSelectedFolderCounts(peer: WebdriverIO.Browser) {
  await peer.execute(() => {
    const observed = window as typeof window & {
      __syntheticFolderCounts?: number[];
      __syntheticFolderTotalCounts?: number[];
      __syntheticEvents?: string[];
      __syntheticFailures?: string[];
      __syntheticIndexes?: string[];
      __syntheticReplicaStates?: string[];
      __syntheticSelectionEvents?: number;
      __syntheticNativeCalls?: Record<string, number>;
      __syntheticHandshakeStages?: string[];
      __syntheticQueueStages?: string[];
      __syntheticSettingsRefresh?: string[];
    };
    observed.__syntheticFolderCounts = [];
    observed.__syntheticFolderTotalCounts = [];
    observed.__syntheticEvents = [];
    observed.__syntheticFailures = [];
    observed.__syntheticIndexes = [];
    observed.__syntheticReplicaStates = [];
    observed.__syntheticSelectionEvents = 0;
    observed.__syntheticNativeCalls = {};
    observed.__syntheticHandshakeStages = [];
    observed.__syntheticQueueStages = [];
    observed.__syntheticSettingsRefresh = [];
    const summary = [...document.querySelectorAll("summary")].find((value) =>
      value.textContent?.includes("View logs"),
    );
    const list = summary?.parentElement?.querySelector("ul.list");
    if (!list) throw new Error("The session log list is unavailable.");
    type Observed = typeof observed;
    // WebdriverIO serializes this callback with Function#toString. Keep helpers
    // as object methods: tsx names function bindings with a module-scoped
    // __name helper that does not exist in the page.
    const handlers = {
      processEntry(entry: Element, node: Element, observed: Observed) {
            const event = entry.textContent?.split(" | ").at(-1)?.trim();
            if (event === "document.session_folders.queued") {
              const details =
                node.querySelector("pre.log-details")?.textContent;
              const stage = details
                ? (JSON.parse(details) as {
                    operation?: string;
                    activeOperation?: string;
                    queuedMs?: number;
                    elapsedMs?: number;
                  })
                : {};
              observed.__syntheticQueueStages?.push(
                `${event}:${stage.operation ?? stage.activeOperation ?? "?"}:` +
                  `${stage.queuedMs ?? stage.elapsedMs ?? 0}`,
              );
              observed.__syntheticQueueStages?.splice(
                0,
                Math.max(0, observed.__syntheticQueueStages.length - 20),
              );
            }
            if (event?.startsWith("tauri.invoke.")) {
              const details =
                node.querySelector("pre.log-details")?.textContent;
              const command = details
                ? (JSON.parse(details) as { command?: string }).command
                : undefined;
              if (
                [
                  "syncpeer_tls_accept",
                  "syncpeer_tls_listen",
                  "syncpeer_replica_storage",
                  "syncpeer_profile_storage_root",
                  "syncpeer_vault_secret",
                ].includes(command ?? "")
              ) {
                const key = `${event}:${command}`;
                observed.__syntheticNativeCalls![key] =
                  (observed.__syntheticNativeCalls![key] ?? 0) + 1;
              }
            }
            if (event?.startsWith("document.settings_refresh.")) {
              const details = node.querySelector("pre.log-details")?.textContent;
              const summary = `${event}:${details ?? "{}"}`;
              observed.__syntheticSettingsRefresh?.push(summary);
              observed.__syntheticSettingsRefresh?.splice(0,
                Math.max(0, observed.__syntheticSettingsRefresh.length - 20));
            }
            if (
              event &&
              /^(client\.|core\.|document\.)/.test(event) &&
              !observed.__syntheticEvents?.includes(event)
            )
              observed.__syntheticEvents?.push(event);
            if (
              event?.startsWith("core.bep.handshake.") ||
              event?.startsWith("core.incoming.trace.") ||
              event === "core.bep.cluster_config.wait"
            ) {
              const details =
                node.querySelector("pre.log-details")?.textContent;
              if (details) {
                const stage = JSON.parse(details) as {
                  direction?: string;
                  connectedHost?: string;
                  connectedPort?: number;
                };
                const summary =
                  `${Date.now()}:${event}:${stage.direction ?? "unknown"}:` +
                  `${stage.connectedHost ?? "?"}:${stage.connectedPort ?? "?"}`;
                if (!observed.__syntheticHandshakeStages?.includes(summary)) {
                  observed.__syntheticHandshakeStages?.push(summary);
                }
              }
            }
            if (
              event === "core.upload.request.failed" ||
              event === "core.replica.receive.failed" ||
              event === "core.replica.scan.failed" ||
              event === "core.socket.closed" ||
              event === "core.incoming.failed" ||
              event === "core.session.refresh.failed"
            ) {
              const details = entry
                .closest("li")
                ?.querySelector("pre.log-details")?.textContent;
              if (details) {
                const message = (JSON.parse(details) as { message?: string })
                  .message;
                if (message && !observed.__syntheticFailures?.includes(message))
                  observed.__syntheticFailures?.push(message);
              }
            }
            if (
              event === "core.replica.index.decision" ||
              event === "core.replica.index.receive.done"
            ) {
              const details = entry
                .closest("li")
                ?.querySelector("pre.log-details")?.textContent;
              if (details) {
                const state = JSON.parse(details) as {
                  internal?: boolean;
                  hasReceiver?: boolean;
                  paused?: boolean;
                  needsPassword?: boolean;
                  fileCount?: number;
                  changed?: boolean;
                };
                const summary = JSON.stringify({
                  event,
                  internal: state.internal,
                  hasReceiver: state.hasReceiver,
                  paused: state.paused,
                  needsPassword: state.needsPassword,
                  fileCount: state.fileCount,
                  changed: state.changed,
                });
                if (!observed.__syntheticReplicaStates?.includes(summary))
                  observed.__syntheticReplicaStates?.push(summary);
              }
            }
            if (
              event === "core.index.received" ||
              event === "core.index.applied"
            ) {
              const details = entry
                .closest("li")
                ?.querySelector("pre.log-details")?.textContent;
              if (details) {
                const info = JSON.parse(details) as {
                  fileCount?: number;
                  storedFiles?: number;
                  processedFiles?: number;
                  decryptedStored?: number;
                  decryptFailed?: number;
                  needsPassword?: boolean;
                  passwordError?: string | null;
                };
                const summary = JSON.stringify({
                  event,
                  fileCount: info.fileCount,
                  storedFiles: info.storedFiles,
                  processedFiles: info.processedFiles,
                  decryptedStored: info.decryptedStored,
                  decryptFailed: info.decryptFailed,
                  needsPassword: info.needsPassword,
                  passwordError: info.passwordError,
                });
                if (!observed.__syntheticIndexes?.includes(summary))
                  observed.__syntheticIndexes?.push(summary);
              }
            }
            if (event !== "client.shared_folders.selected") return;
            observed.__syntheticSelectionEvents =
              (observed.__syntheticSelectionEvents ?? 0) + 1;
            const details = node.querySelector("pre.log-details")?.textContent;
            if (!details) return;
            const counts = JSON.parse(details) as {
              count?: number;
              internalCount?: number;
            };
            if (
              typeof counts.internalCount === "number" &&
              !observed.__syntheticFolderCounts?.includes(counts.internalCount)
            ) {
              observed.__syntheticFolderCounts?.push(counts.internalCount);
            }
            if (
              typeof counts.count === "number" &&
              !observed.__syntheticFolderTotalCounts?.includes(counts.count)
            ) {
              observed.__syntheticFolderTotalCounts?.push(counts.count);
            }
      },
      processNode(node: Node, observed: Observed) {
        if (!(node instanceof Element) || !node.matches("li")) return;
        for (const entry of node.querySelectorAll(".item-meta")) {
          handlers.processEntry(entry, node, observed);
        }
      },
    };
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) handlers.processNode(node, observed);
    });
    observer.observe(list, { childList: true });
  });
}

async function captureReconnectDiagnostics(
  owner: WebdriverIO.Browser,
  joiner: WebdriverIO.Browser,
  ports: readonly number[],
) {
  const rawPeers = await Promise.all(
    [owner, joiner].map((peer) =>
      peer
        .execute(() => {
          const observed = window as typeof window & {
            __syntheticEvents?: string[];
            __syntheticFailures?: string[];
            __syntheticHandshakeStages?: string[];
            __syntheticSettingsRefresh?: string[];
            __syntheticFolderCounts?: number[];
            __syntheticFolderTotalCounts?: number[];
            __syntheticSelectionEvents?: number;
            __syntheticReplicaStates?: string[];
            __syntheticQueueStages?: string[];
          };
          return {
            status:
              document
                .querySelector("[data-testid='connection-status']")
                ?.textContent?.trim() ?? "missing",
            control:
              document.querySelector(
                "[data-testid='expert-connection-control']",
              )?.textContent ?? "",
            error: document.querySelector("p.error")?.textContent?.trim() ?? "",
            events: observed.__syntheticEvents?.slice(-12) ?? [],
            failures: observed.__syntheticFailures?.slice(-8) ?? [],
            handshakeStages:
              observed.__syntheticHandshakeStages?.slice(-8) ?? [],
            settingsRefresh: observed.__syntheticSettingsRefresh?.slice(-20) ?? [],
            folderCounts: observed.__syntheticFolderCounts ?? [],
            folderTotalCounts: observed.__syntheticFolderTotalCounts ?? [],
            selectionEvents: observed.__syntheticSelectionEvents ?? 0,
            replicaStates: observed.__syntheticReplicaStates?.slice(-20) ?? [],
            queueStages: observed.__syntheticQueueStages?.slice(-20) ?? [],
          };
        })
        .catch(error => { console.log("Packaged diagnostic unavailable:", String(error)); return null; }),
    ),
  );
  const categorize = (message: string) =>
    /ECONNREFUSED|connection refused/i.test(message)
      ? "connection-refused"
      : /timed out|timeout/i.test(message)
        ? "timeout"
        : /listener|address already in use/i.test(message)
          ? "listener"
          : /vault|locked/i.test(message)
            ? "vault"
            : message
              ? "other"
              : "none";
  const peers = rawPeers.map((value) =>
    value === null
      ? { status: "webdriver-unavailable" }
      : {
          status: value.status,
          control: value.control.includes("Pause automatic connection")
            ? "resumed"
            : "paused-or-missing",
          appError: categorize(value.error),
          events: value.events,
          failures: value.failures.map(categorize),
          handshakeStages: value.handshakeStages.map((stage) =>
            stage.split(":").slice(1, 3).join(":"),
          ),
          settingsRefresh: value.settingsRefresh,
          folderCounts: value.folderCounts,
          folderTotalCounts: value.folderTotalCounts,
          selectionEvents: value.selectionEvents,
          replicaStates: value.replicaStates,
          queueStages: value.queueStages,
        },
  );
  const listeners = await Promise.all(ports.map(isListening));
  return {
    peers,
    listeners: ports.map((port, index) => ({
      port,
      listening: listeners[index],
    })),
  };
}

async function attachAndFavoriteSharedFolder(peer: WebdriverIO.Browser) {
  await peer.$("[data-testid='tab-folders']").click();
  await openFolderSettings(peer, folderName);
  const row = peer.$(
    `//li[./span[normalize-space()=${JSON.stringify(folderName)}]]`,
  );
  try {
    // Keep the settings page mounted while its onMount refresh serializes behind
    // any in-flight settings-replica work. Repeatedly leaving/reopening this page
    // used to cancel the UI that owned the result and enqueue overlapping status calls.
    await row.waitForExist({
      timeout: 30_000,
      timeoutMsg:
        "The received shared folder did not appear after the settings refresh completed.",
    });
  } catch (error) {
    const lastAlert = await peer
      .$("p[role='alert']")
      .getText()
      .catch(() => "");
    const sawFolderElsewhere = await peer.execute(
      (name) => document.body.innerText.includes(name),
      folderName,
    );
    const vaultLocked = await peer
      .$("//label[contains(.,'Unlock existing storage')]")
      .isExisting();
    const hasSharedConflict = await peer
      .$("//h2[normalize-space()='Shared settings need a choice']")
      .isExisting();
    await peer.$("[data-testid='tab-devices']").click();
    const events = await peer.execute(
      () =>
        (
          window as typeof window & {
            __syntheticEvents?: string[];
          }
        ).__syntheticEvents ?? [],
    );
    const indexes = await peer.execute(
      () =>
        (
          window as typeof window & {
            __syntheticIndexes?: string[];
          }
        ).__syntheticIndexes ?? [],
    );
    const failures = await peer.execute(
      () =>
        (
          window as typeof window & {
            __syntheticFailures?: string[];
          }
        ).__syntheticFailures ?? [],
    );
    const replicaStates = await peer.execute(
      () =>
        (
          window as typeof window & {
            __syntheticReplicaStates?: string[];
          }
        ).__syntheticReplicaStates ?? [],
    );
    const queueStages = await peer.execute(
      () =>
        (
          window as typeof window & {
            __syntheticQueueStages?: string[];
          }
        ).__syntheticQueueStages ?? [],
    );
    const logSummary = await peer.execute(
      () =>
        [...document.querySelectorAll("summary")]
          .find((element) => element.textContent?.includes("View logs"))
          ?.textContent?.trim() ?? "missing",
    );
    throw new Error(
      `The approved folder credential did not reach the joined desktop. ` +
        `Visible elsewhere: ${sawFolderElsewhere}; vault locked: ${vaultLocked}; ` +
        `settings conflict: ${hasSharedConflict}; settings alert: ${lastAlert || "none"}; ` +
        `${logSummary}; recent events: ${events.join(",")}; index summaries: ${indexes.join(",")}; ` +
        `receive failures: ${failures.join(",")}; replica states: ${replicaStates.join(",")}; ` +
        `queue stages: ${JSON.stringify(queueStages)}.`,
      { cause: error },
    );
  }

  const attach = row.$("button=Reattach encrypted local storage");
  if (await attach.isExisting()) {
    await clickButtonByText(peer, "Reattach encrypted local storage");
    await attach.waitForExist({ reverse: true, timeout: 30_000 });
  }
  await peer.$("button=Back").click();
  const root = peer.$(
    `//li[.//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(folderName)}]]`,
  );
  await root.waitForExist({ timeout: 30_000 });
  const favorite = root.$("button[aria-label='Toggle favorite']");
  if ((await favorite.getAttribute("aria-pressed")) !== "true") {
    const selected = await peer.execute((name) => {
      const title = [...document.querySelectorAll(".item-title")].find(
        (element) => element.textContent?.trim() === name,
      );
      const button = title
        ?.closest("li")
        ?.querySelector("button[aria-label='Toggle favorite']");
      if (!(button instanceof HTMLButtonElement) || button.disabled)
        return false;
      button.click();
      return true;
    }, folderName);
    assert.ok(
      selected,
      "The packaged peer could not favorite the shared folder.",
    );
    await peer.waitUntil(
      async () => (await favorite.getAttribute("aria-pressed")) === "true",
      {
        timeout: 5_000,
        timeoutMsg: "The packaged shared folder was not favorited.",
      },
    );
  }
}
describe("Two isolated packaged desktop apps", () => {
  it("start with distinct protected device identities", async () => {
    const { owner, joiner } = peers();
    await Promise.all(
      [owner, joiner].map(async (peer) => {
        await peer
          .$("[data-testid='tab-devices']")
          .waitForExist({ timeout: 60_000 });
        await peer.execute(() => {
          (document.querySelector("[data-testid='tab-devices']") as HTMLButtonElement).click();
        });
        await peer
          .$("[data-testid='current-device-id']")
          .waitForExist({ timeout: 60_000 });
        await peer.waitUntil(
          async () =>
            /^[A-Z2-7-]{40,}$/.test(
              await peer.$("[data-testid='current-device-id']").getText(),
            ),
          {
            timeout: 60_000,
            timeoutMsg: "The protected device identity did not finish loading.",
          },
        );
      }),
    );
    const ownerId = await owner
      .$("[data-testid='current-device-id']")
      .getText();
    const joinerId = await joiner
      .$("[data-testid='current-device-id']")
      .getText();
    assert.match(ownerId, /^[A-Z2-7-]{40,}$/);
    assert.match(joinerId, /^[A-Z2-7-]{40,}$/);
    assert.notEqual(ownerId, joinerId);
  });

  it("pairs with one matching confirmation code", async () => {
    const { owner, joiner } = peers();
    await createFreshEncryptedProfile(owner);
    await openGeneralSettings(joiner);
    await owner
      .$("//label[contains(., 'LAN host/IP or relay:// URL')]/input")
      .setValue("127.0.0.1");
    const createInvitation = owner.$("button=Create pairing invitation");
    await createInvitation.waitForEnabled({ timeout: 30_000 });
    await createInvitation.click();
    const invitationInput = owner.$(
      "//label[contains(., 'Invitation')]/textarea[@readonly]",
    );
    try {
      await invitationInput.waitForExist({ timeout: 30_000 });
    } catch (error) {
      const issue = await owner
        .$("p[role='alert']")
        .getText()
        .catch(() => "No pairing error was shown.");
      throw new Error(`Packaged pairing invitation failed: ${issue}`, {
        cause: error,
      });
    }
    const invitation = await invitationInput.getValue();
    assert.ok(invitation.includes("endpoint"));
    await joiner
      .$("//label[contains(., 'Pairing invitation')]/textarea")
      .setValue(invitation);
    await joiner
      .$("//label[contains(., 'New local master password')]/input")
      .setValue("synthetic-joining-master-password");
    const confirmationPeers = [
      { peer: owner, label: "owner" },
      { peer: joiner, label: "joiner" },
    ];
    await Promise.all(
      confirmationPeers.map(({ peer }) =>
        peer.execute(() => {
          const observed = window as typeof window & {
            __syntheticPairingConfirmations?: string[];
          };
          observed.__syntheticPairingConfirmations = [];
          window.confirm = (message?: string) => {
            observed.__syntheticPairingConfirmations?.push(
              String(message ?? ""),
            );
            return true;
          };
        }),
      ),
    );
    await clickButtonByText(joiner, "Join personal space");
    const codes = new Map<string, string>();
    for (const { peer, label } of confirmationPeers) {
      await peer.waitUntil(
        async () => {
          const messages = await peer.execute(
            () =>
              (
                window as typeof window & {
                  __syntheticPairingConfirmations?: string[];
                }
              ).__syntheticPairingConfirmations ?? [],
          );
          return messages.some((message) => /\b\d{6}\b/.test(message));
        },
        {
          timeout: 30_000,
          timeoutMsg: `Pairing confirmation callback was not invoked on ${label}.`,
        },
      );
      const messages = await peer.execute(
        () =>
          (
            window as typeof window & {
              __syntheticPairingConfirmations?: string[];
            }
          ).__syntheticPairingConfirmations ?? [],
      );
      const code = messages
        .map((message) => message.match(/\b\d{6}\b/)?.[0])
        .find(Boolean);
      assert.ok(
        code,
        `Pairing confirmation on ${label} must include a six-digit code.`,
      );
      codes.set(label, code);
    }
    assert.equal(codes.get("owner"), codes.get("joiner"));
    try {
      await owner
        .$("//*[contains(text(),'Device paired and approved.')]")
        .waitForExist({ timeout: 120_000 });
      await joiner
        .$("//*[contains(text(),'Personal space joined and device approved.')]")
        .waitForExist({ timeout: 120_000 });
    } catch (error) {
      const diagnostics = await Promise.all(
        confirmationPeers.map(async ({ peer, label }) => {
          const state = await peer.execute(() => ({
            alert:
              document.querySelector("p[role='alert']")?.textContent?.trim() ??
              "",
            errors: [...document.querySelectorAll("p.error")]
              .map((value) => value.textContent?.trim())
              .filter(Boolean),
            events: [...document.querySelectorAll("li .item-meta")]
              .map((value) => value.textContent?.split(" | ").at(-1)?.trim())
              .filter((value): value is string => Boolean(value))
              .filter((value) => value.startsWith("client.pairing."))
              .slice(-20),
          }));
          return { label, ...state };
        }),
      );
      throw new Error(
        `Packaged pairing did not complete: ${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
    await Promise.all(
      [owner, joiner].map(async (peer) => {
        await peer
          .$("[data-testid='general-settings-page']")
          .waitForExist({ timeout: 30_000 });
        await peer
          .$("//h2[normalize-space()='Devices with access to this space']")
          .waitForExist({ timeout: 30_000 });
      }),
    );
    const memberships: string[][] = [];
    for (const peer of [owner, joiner]) {
      await peer.waitUntil(
        async () =>
          peer.execute(() => {
            const heading = [...document.querySelectorAll("h2")].find(
              (value) =>
                value.textContent?.trim() ===
                "Devices with access to this space",
            );
            return (
              (heading?.parentElement?.querySelectorAll("code").length ?? 0) >=
              2
            );
          }),
        {
          timeout: 30_000,
          timeoutMsg:
            "The signed trusted-device list did not finish refreshing.",
        },
      );
      const listed = await peer.execute(() => {
        const heading = [...document.querySelectorAll("h2")].find(
          (value) =>
            value.textContent?.trim() === "Devices with access to this space",
        );
        return [
          ...(heading?.parentElement?.querySelectorAll("code") ?? []),
        ].map((code) => code.textContent?.trim() ?? "");
      });
      assert.ok(
        listed.length >= 2,
        "The trusted-device list must contain both packaged peers.",
      );
      memberships.push(listed.map((value) => value.replaceAll("-", "")).sort());
    }
    assert.deepEqual(
      memberships[0],
      memberships[1],
      "Both packaged devices must agree on the signed membership.",
    );
    await captureScreenshot(owner, "personal-space");
  });

  it("replicates a whole favorite folder in both directions", async () => {
    const { owner, joiner } = peers();
    console.log("Packaged folder test: leaving pairing screens.");
    for (const peer of [owner, joiner]) {
      await acceptPendingApproval(peer);
      const back = peer.$("button=Back");
      await back.waitForExist({ timeout: 30_000 });
      await back.click();
      await peer.$("[data-testid='tab-devices']").click();
    }
    const [ownerId, joinerId] = await Promise.all(
      [owner, joiner].map(async (peer) => {
        const deviceId = peer.$("[data-testid='current-device-id']");
        await deviceId.waitForExist({ timeout: 60_000 });
        return deviceId.getText();
      }),
    );
    await owner.$("[data-testid='tab-folders']").click();
    const newFolder = owner.$("[data-testid='new-folder']");
    await newFolder.waitForExist({ timeout: 30_000 });
    await newFolder.click();
    await owner
      .$("[data-testid='new-folder-page']")
      .waitForExist({ timeout: 30_000 });
    console.log("Packaged folder test: creating owner folder.");
    const folderNameInput = owner.$(
      "//label[contains(., 'New folder name')]/input",
    );
    await folderNameInput.waitForExist({ timeout: 30_000 });
    await folderNameInput.setValue(folderName);
    assert.equal(
      await folderNameInput.getValue(),
      folderName,
    );
    console.log("Packaged folder test: owner folder name entered.");
    const createFolder = owner.$("button=Create folder");
    await createFolder.waitForEnabled({ timeout: 10_000 });
    console.log("Packaged folder test: submitting owner folder.");
    await clickButtonByText(owner, "Create folder");
    console.log("Packaged folder test: waiting for owner folder list.");
    try {
      const folderExists = async () => owner.execute(
        name => [...document.querySelectorAll("[data-testid^='folder-root-'] .item-title")]
          .some(title => title.textContent?.trim() === name),
        folderName,
      );
      await owner.waitUntil(folderExists, { timeout: 30_000, interval: 1_000,
        timeoutMsg: "The newly created folder did not return to the folder list." });
      assert.ok(
        await folderExists(),
        "The newly created folder is absent from the folder list.",
      );
      console.log("Packaged folder test: owner folder listed.");
      await captureScreenshot(owner, "encrypted-folder");
    } catch (error) {
      const issue = await owner
        .$("p[role='alert']")
        .getText()
        .catch(() => "none");
      const state = await owner.execute(() => ({
        heading: [...document.querySelectorAll("h1, h2")]
          .map((value) => value.textContent?.trim())
          .slice(0, 8),
        folderNameInput:
          [...document.querySelectorAll("label")]
            .find((value) => value.textContent?.includes("New folder name"))
            ?.querySelector("input")?.value ?? "missing",
        folders: [...document.querySelectorAll("[data-testid^='folder-root-'] .item-title")]
          .map((value) => value.textContent?.trim())
          .filter(Boolean),
        status: [...document.querySelectorAll("p[role='status'], p.error")].map(
          (value) => value.textContent?.trim(),
        ),
      }));
      throw new Error(
        `Packaged owner folder creation failed: ${issue}; ${JSON.stringify(state)}`,
        { cause: error },
      );
    }
    await owner.$("[data-testid='tab-devices']").click();
    console.log("Packaged folder test: preparing peer connection.");
    await joiner.$("//label[contains(., 'Device ID')]/input").setValue(ownerId);
    await joiner.$("button=Add Device").click();
    const ownerPort = await freePort();
    let joinerPort = await freePort();
    while (joinerPort === ownerPort) joinerPort = await freePort();
    // Signed enrollment was confirmed in the preceding case. The first live
    // connection also asks for a separate device/folder approval.
    await Promise.all(
      [owner, joiner].map((peer, index) =>
        peer.execute(
          (name: string) => {
            window.confirm = () => true;
            window.prompt = () => name;
          },
          `synthetic-desktop-${index + 1}`,
        ),
      ),
    );
    await focusPeer(joiner);
    await configureConnection(owner, joinerId, joinerPort, ownerPort);
    await focusPeer(owner);
    await configureConnection(joiner, ownerId, ownerPort, joinerPort);
    for (const peer of [owner, joiner]) {
      await focusPeer(peer === owner ? joiner : owner);
      assert.equal(await peer.execute(() => document.hasFocus()), false);
      await setAutomaticConnectionPaused(peer, true);
      await setAutomaticConnectionPaused(peer, true);
      assert.equal(
        (await peer.$("[data-testid='expert-connection-control']").getText()).trim(),
        "Resume automatic connection",
        "Repeated pause requests must leave this peer paused.",
      );
    }
    await Promise.all([owner, joiner].map(captureSelectedFolderCounts));
    console.log("Packaged folder test: resuming direct connections.");
    // The higher device ID accepts the retained socket. Resume it first;
    // each app's connection loop then keeps trying until the listener is ready.
    const ownerAccepts =
      preferredPeerDirection(ownerId, joinerId) === "incoming";
    const acceptor = ownerAccepts ? owner : joiner;
    const dialer = ownerAccepts ? joiner : owner;
    await focusPeer(dialer);
    assert.equal(await acceptor.execute(() => document.hasFocus()), false);
    await setAutomaticConnectionPaused(acceptor, false);
    await setAutomaticConnectionPaused(acceptor, false);
    assert.equal(
      (await dialer.$("[data-testid='expert-connection-control']").getText()).trim(),
      "Resume automatic connection",
      "Resuming the acceptor must leave the dialer paused.",
    );
    const acceptorPort = ownerAccepts ? ownerPort : joinerPort;
    try {
      await acceptor.waitUntil(() => isListening(acceptorPort), {
        timeout: 30_000,
        timeoutMsg:
          "The packaged acceptor did not open its configured LAN listener.",
      });
      await focusPeer(acceptor);
      assert.equal(await dialer.execute(() => document.hasFocus()), false);
      await setAutomaticConnectionPaused(dialer, false);
      await setAutomaticConnectionPaused(dialer, false);
      for (const peer of [owner, joiner]) {
        assert.equal(
          (await peer.$("[data-testid='expert-connection-control']").getText()).trim(),
          "Pause automatic connection",
          "Both background peers must resume before waiting for a connection.",
        );
      }
      await Promise.all(
        [owner, joiner].map((peer) =>
          peer.waitUntil(
            async () => {
              try {
                return (
                  await peer.$("[data-testid='connection-status']").getText()
                ).includes("Connected");
              } catch (error) {
                if (String(error).includes("unexpected alert open")) {
                  await acceptPendingApproval(peer);
                  return false;
                }
                throw error;
              }
            },
            {
              timeout: 120_000,
              timeoutMsg: "Packaged desktop peers did not connect.",
            },
          ),
        ),
      );
    } catch (error) {
      const phases = await Promise.all(
        [owner, joiner].map(async (peer) => ({
          phase: await peer
            .$("[data-testid='connection-status']")
            .getText()
            .catch(() => "unavailable"),
          error: await peer
            .$("p.error")
            .getText()
            .catch(() => "none"),
          control: await peer
            .$("[data-testid='expert-connection-control']")
            .getText()
            .catch(() => "unavailable"),
          host: await peer
            .$("[data-testid='connection-host']")
            .getValue()
            .catch(() => "unavailable"),
          port: await peer
            .$("[data-testid='connection-port']")
            .getValue()
            .catch(() => "unavailable"),
          listenPort: await peer
            .$("[data-testid='connection-listen-port']")
            .getValue()
            .catch(() => "unavailable"),
          events: await peer.execute(
            () =>
              (
                window as typeof window & {
                  __syntheticEvents?: string[];
                }
              ).__syntheticEvents ?? [],
          ),
          failures: await peer.execute(
            () =>
              (
                window as typeof window & {
                  __syntheticFailures?: string[];
                }
              ).__syntheticFailures ?? [],
          ),
          handshake: await peer.execute(
            () =>
              (
                window as typeof window & {
                  __syntheticHandshakeStages?: string[];
                }
              ).__syntheticHandshakeStages ?? [],
          ),
          selections: await peer.execute(
            () =>
              (
                window as typeof window & {
                  __syntheticFolderCounts?: number[];
                }
              ).__syntheticFolderCounts ?? [],
          ),
          selectionEvents: await peer.execute(
            () =>
              (
                window as typeof window & {
                  __syntheticSelectionEvents?: number;
                }
              ).__syntheticSelectionEvents ?? 0,
          ),
          nativeCalls: await peer.execute(
            () =>
              (
                window as typeof window & {
                  __syntheticNativeCalls?: Record<string, number>;
                }
              ).__syntheticNativeCalls ?? {},
          ),
          queueStages: await peer.execute(
            () =>
              (
                window as typeof window & {
                  __syntheticQueueStages?: string[];
                }
              ).__syntheticQueueStages ?? [],
          ),
        })),
      );
      const listeners = await Promise.all(
        [ownerPort, joinerPort, 22000].map(isListening),
      );
      throw new Error(
        `Packaged desktop connection failed: ${JSON.stringify(phases)}; ` +
          `expected listeners: ${JSON.stringify(listeners)}.`,
        { cause: error },
      );
    }
    for (const peer of [owner, joiner]) {
      const selections = await peer.execute(
        () =>
          (
            window as typeof window & {
              __syntheticFolderCounts?: number[];
            }
          ).__syntheticFolderCounts ?? [],
      );
      assert.ok(
        selections.includes(1),
        `The packaged peer did not select its encrypted settings replica: ${JSON.stringify(selections)}.`,
      );
    }
    try {
      await joiner.waitUntil(
        async () => {
          const states = await joiner.execute(
            () =>
              (
                window as typeof window & {
                  __syntheticReplicaStates?: string[];
                }
              ).__syntheticReplicaStates ?? [],
          );
          return states.some((value) => {
            const state = JSON.parse(value) as {
              event?: string;
              internal?: boolean;
              changed?: boolean;
            };
            return (
              state.event === "core.replica.index.receive.done" &&
              state.internal === true &&
              state.changed === true
            );
          });
        },
        {
          timeout: 20_000,
          timeoutMsg:
            "The packaged personal-space settings replica did not finish receiving within the BEP request budget.",
        },
      );
    } catch (error) {
      const diagnostics = await captureReconnectDiagnostics(owner, joiner, [
        ownerPort,
        joinerPort,
      ]);
      throw new Error(
        `Packaged settings replica failed: ${JSON.stringify(diagnostics)}.`,
        { cause: error },
      );
    }
    // Observe Folders before the joiner changes its selection. A folder-row
    // assertion while Devices is selected cannot prove automatic view refresh.
    await owner.$("[data-testid='tab-folders']").click();
    try {
      await attachAndFavoriteSharedFolder(joiner);
    } catch (error) {
      const ownerEvents = await owner.execute(() => {
        const observed = window as typeof window & {
          __syntheticEvents?: string[];
          __syntheticFailures?: string[];
          __syntheticIndexes?: string[];
        };
        return {
          __syntheticEvents: observed.__syntheticEvents,
          __syntheticFailures: observed.__syntheticFailures,
          __syntheticIndexes: observed.__syntheticIndexes,
        };
      });
      throw new Error(
        `${String(error)}; owner events: ${ownerEvents.__syntheticEvents?.join(",")}; ` +
          `upload failures: ${ownerEvents.__syntheticFailures?.join(",")}; ` +
          `owner indexes: ${ownerEvents.__syntheticIndexes?.join(",")}.`,
        { cause: error },
      );
    }
    console.log(
      "Packaged folder test: waiting for automatic peer-view refresh.",
    );
    try {
      await waitForSessionFolder(
        joiner,
        folderName,
        "The joined desktop did not automatically reopen with the approved shared folder.",
      );
      await waitForSessionFolder(
        owner,
        folderName,
        "The owner did not reopen its session with the newly shared folder.",
      );
    } catch (error) {
      const diagnostics = await captureReconnectDiagnostics(owner, joiner, [
        ownerPort,
        joinerPort,
      ]);
      const renderedFolders = await joiner.execute(() =>
        [...document.querySelectorAll("[data-testid^='folder-root-']")]
          .map(row => row.textContent?.replace(/\s+/g, " ").trim() ?? ""))
        .catch(() => []);
      throw new Error(
        "Packaged automatic peer-view refresh failed: " +
          JSON.stringify({ diagnostics, renderedFolders }) +
          ".",
        { cause: error },
      );
    }
    console.log(
      "Packaged folder test: automatic peer-view refresh selected the shared folder.",
    );
    const storeProbe = (peer: WebdriverIO.Browser) => peer.execute(() =>
      (window as typeof window & { __syncpeerStoreStateProbe?: () => unknown })
        .__syncpeerStoreStateProbe?.() ?? null);
    console.log("Store after refresh:", JSON.stringify({
      owner: await storeProbe(owner), joiner: await storeProbe(joiner),
    }));
    await openFolder(owner, folderName);
    console.log("Owner after open:", JSON.stringify(await storeProbe(owner)));
    await uploadFile(owner, "from-owner.txt", "owner-one");
    await openFolder(joiner, folderName);
    console.log("Joiner after open:", JSON.stringify(await storeProbe(joiner)));
    await waitForFile(joiner, "from-owner.txt");
    console.log("Joiner after file arrives:", JSON.stringify(await storeProbe(joiner)));
    await uploadFile(joiner, "from-joiner.txt", "joiner-one");
    await waitForFile(owner, "from-joiner.txt");
    await captureScreenshot(owner, "sync");
  });

  it("reconnects through official global discovery and the public relay network", async function () {
    if (process.env.SYNCPEER_RUN_EXTERNAL_CHECKS !== "1") this.skip();
    const { owner, joiner } = peers();

    for (const peer of [owner, joiner]) {
      await setAutomaticConnectionPaused(peer, true);
      await peer.waitUntil(
        async () =>
          !(
            await peer.$("[data-testid='connection-status']").getText()
          ).includes("Connected"),
        {
          timeout: 30_000,
          interval: 250,
          timeoutMsg:
            "Packaged desktop did not close its direct session before public-network testing.",
        },
      );

      await peer
        .$("[data-testid='connection-discovery-mode']")
        .selectByAttribute("value", "global");
      await peer
        .$("[data-testid='connection-discovery-server']")
        .setValue("https://discovery-lookup.syncthing.net/v2/?noannounce");
      await peer.execute(() => {
        const relayFallback = document.querySelector(
          "[data-testid='connection-relay-fallback']",
        ) as HTMLInputElement | null;
        if (!relayFallback)
          throw new Error("Relay fallback control is unavailable.");
        if (!relayFallback.checked) relayFallback.click();
      });
      await peer.pause(750);
      assert.equal(
        await peer.$("[data-testid='connection-discovery-mode']").getValue(),
        "global",
      );
      assert.equal(
        await peer.$("[data-testid='connection-discovery-server']").getValue(),
        "https://discovery-lookup.syncthing.net/v2/?noannounce",
      );
    }

    await Promise.all(
      [owner, joiner].map((peer) => setAutomaticConnectionPaused(peer, false)),
    );
    await Promise.all(
      [owner, joiner].map((peer) =>
        peer.waitUntil(
          async () =>
            (
              await peer.$("[data-testid='connection-status']").getText()
            ).includes("Connected"),
          {
            timeout: 420_000,
            interval: 1_000,
            timeoutMsg:
              "Packaged desktops did not reconnect through public discovery/relay.",
          },
        ),
      ),
    );

    for (const peer of [owner, joiner]) {
      await peer.waitUntil(
        async () =>
          (
            await peer.$("[data-testid='connection-details']").getText()
          ).includes("Path: relay://"),
        {
          timeout: 30_000,
          interval: 500,
          timeoutMsg:
            "Packaged public-network session was not reported as relay transport.",
        },
      );
    }

    await openFolder(owner, folderName);
    await uploadFile(owner, "public-relay-owner.txt", "public-relay-owner");
    await openFolder(joiner, folderName);
    await waitForFile(joiner, "public-relay-owner.txt");
    console.log(
      "Packaged public-network gate passed: official discovery + public relay + encrypted file convergence.",
    );
  });
});
