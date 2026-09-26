import assert from "node:assert/strict";
import test from "node:test";
import {
  folderRootEmptyNotice,
  localDiscoveryUnavailableNotice,
} from "../packages/app/src/app/connectionNotices.ts";
import { createTauriAdapters, reportUiError, shouldLogInvokeLifecycle } from "../packages/app/src/lib/tauriAdapters.ts";
import { reportClientError } from "@syncpeer/core/browser";

test("explains an empty folder list on a healthy connection", () => {
  assert.equal(
    folderRootEmptyNotice(true, 0),
    "Connected, but the remote device is not sharing any folders with this device. Share a folder with this device in the remote Syncthing settings.",
  );
  assert.equal(folderRootEmptyNotice(false, 0), "Connect to browse folders.");
  assert.equal(folderRootEmptyNotice(true, 1), null);
});

test("explains local discovery port contention without implying connection failure", () => {
  assert.equal(
    localDiscoveryUnavailableNotice(
      new Error("Local discovery sockets unavailable (udp4 bind failed: Address already in use (os error 98))."),
    ),
    "Local discovery is unavailable because another application is already using its network port. This often happens when another Syncthing instance is running on this computer. Automatic, global, direct, and relay connections can still work.",
  );
});

test("does not reclassify unrelated discovery failures", () => {
  assert.equal(localDiscoveryUnavailableNotice(new Error("Network request failed")), null);
});

test("high-frequency storage and socket operations do not flood the visible session log", () => {
  assert.equal(shouldLogInvokeLifecycle("syncpeer_replica_storage"), false);
  assert.equal(shouldLogInvokeLifecycle("syncpeer_tls_read"), false);
  assert.equal(shouldLogInvokeLifecycle("syncpeer_tls_write"), false);
  assert.equal(shouldLogInvokeLifecycle("syncpeer_tls_listen"), true);
});

test("serializes overlapping native local discovery calls", async () => {
  let discoveryCalls = 0;
  let releaseFirstDiscovery = () => {};
  const firstDiscovery = new Promise<void>((resolve) => {
    releaseFirstDiscovery = resolve;
  });
  const scope = globalThis as typeof globalThis & {
    __TAURI__?: {
      core?: {
        invoke?: <T>(command: string) => Promise<T>;
      };
    };
  };
  const previousTauri = scope.__TAURI__;
  scope.__TAURI__ = {
    core: {
      invoke: async <T>(command: string): Promise<T> => {
        if (command === "syncpeer_android_enable_multicast_lock") return false as T;
        assert.equal(command, "syncpeer_discovery_local");
        discoveryCalls += 1;
        if (discoveryCalls === 1) await firstDiscovery;
        return {
          candidates: [],
          diagnostics: {
            socketsBound: 0,
            syncpeerLanActive: true,
          },
        } as T;
      },
    },
  };

  try {
    const discover = createTauriAdapters().hostAdapter.discoverLocalCandidates;
    assert.ok(discover);
    const first = discover({ expectedDeviceId: "FIRST", timeoutMs: 1200 });
    await Promise.resolve();
    const second = discover({ expectedDeviceId: "SECOND", timeoutMs: 1400 });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(discoveryCalls, 1);
    releaseFirstDiscovery();
    await Promise.all([first, second]);
    assert.equal(discoveryCalls, 2);
  } finally {
    scope.__TAURI__ = previousTauri;
  }
});

test("native error logging keeps raw errors in the caller but not diagnostics", async () => {
  const privateMessage = "synthetic failure at /private/fixture from 192.0.2.44 DEVICE-SENTINEL";
  const forwarded: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const entries: unknown[] = [];
  const consoleErrors: unknown[][] = [];
  const scope = globalThis as typeof globalThis & {
    __TAURI__?: { core?: { invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T> } };
  };
  const previousTauri = scope.__TAURI__;
  const previousConsoleError = console.error;
  scope.__TAURI__ = { core: { invoke: async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === "syncpeer_log_ui_error") {
      forwarded.push({ command, args });
      return undefined as T;
    }
    throw new Error(privateMessage);
  } } };
  console.error = (...args: unknown[]) => { consoleErrors.push(args); };
  try {
    const adapter = createTauriAdapters({ runtimePlatform: "linux", onLog: entry => entries.push(entry) });
    await assert.rejects(adapter.platformAdapter.getDefaultDeviceId(), new RegExp(privateMessage));
    reportUiError("ui.synthetic", new Error(privateMessage), { path: "/private/fixture", count: 1 });
    await Promise.resolve();
    const published = JSON.stringify({ forwarded, entries, consoleErrors: consoleErrors.map(args =>
      args.map(value => value instanceof Error ? value.message : value)) });
    assert.equal(published.includes(privateMessage), false);
    assert.equal(published.includes("/private/fixture"), false);
    assert.equal(consoleErrors.flat().some(value => value instanceof Error), false);
    assert.equal(forwarded.length, 2);
  } finally {
    scope.__TAURI__ = previousTauri;
    console.error = previousConsoleError;
  }
});

test("core client error reporting omits arbitrary error and context text", async () => {
  const privateMessage = "synthetic failure at /private/core from 192.0.2.45";
  const forwarded: unknown[] = [];
  const consoleErrors: unknown[][] = [];
  const previousConsoleError = console.error;
  console.error = (...args: unknown[]) => { consoleErrors.push(args); };
  try {
    await reportClientError({ logError: async (...args) => { forwarded.push(args); } },
      "client.synthetic", new Error(privateMessage), { path: "/private/core" });
    const published = JSON.stringify({ forwarded, consoleErrors });
    assert.equal(published.includes(privateMessage), false);
    assert.equal(published.includes("/private/core"), false);
  } finally {
    console.error = previousConsoleError;
  }
});
