import assert from "node:assert/strict";
import test from "node:test";
import { createAppBuildInfo } from "../packages/core/src/browser.ts";
import { createConnectionActions } from "../packages/app/src/app/connectionActions.ts";
import { createInitialState, pushSessionLog } from "../packages/app/src/app/state.ts";
import {
  CLIPBOARD_SESSION_LOG_LIMIT_BYTES,
  formatSessionLogs,
  sessionLogFileName,
  sessionLogTextSize,
  type SessionLogFilePort,
} from "../packages/app/src/app/sessionLogs.ts";

const appInfo = createAppBuildInfo({
  appVersion: "test",
  coreVersion: "test",
  buildCommit: "test-commit",
  buildTimeUtc: "2026-01-01T00:00:00.000Z",
  buildMode: "production",
  runtimeEnvironment: "tauri",
  runtimeSurface: "android-ui",
  platform: "android",
  architecture: "arm64",
  osVersion: "synthetic-os",
});

const clipboard = () => {
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
  });
  return copied;
};

const createFixture = (logFile?: SessionLogFilePort) => {
  const state = createInitialState(null);
  const calls: { saved: Array<[string, string]>; shared: Array<[string, string]> } = { saved: [], shared: [] };
  const port = logFile ?? {
    save: async (fileName: string, text: string) => { calls.saved.push([fileName, text]); return fileName; },
    share: async (fileName: string, text: string) => { calls.shared.push([fileName, text]); },
  };
  const actions = createConnectionActions({
    state,
    client: {} as never,
    sessionStore: {} as never,
    transfers: { transferInProgress: () => false } as never,
    syncStarredFiles: async () => undefined,
    loadFavoriteSyncStates: async () => undefined,
    appInfo,
    logFile: port,
  });
  return { state, actions, calls };
};

test("formatted logs keep messages and sanitized metadata", () => {
  const state = createInitialState(null);
  pushSessionLog(state, "error", "ui.error", "Connection is suspended or offline.");
  pushSessionLog(state, "info", "core.discovery.candidate.failed", "core.discovery.candidate.failed",
    { host: "192.0.2.10", port: 22000 });
  const text = formatSessionLogs(appInfo, state.logs.items);
  assert.match(text, /^app_name: Syncpeer/m);
  assert.match(text, /^# Session Logs$/m);
  assert.match(text, /\[ERROR\] ui\.error\nConnection is suspended or offline\./);
  assert.match(text, /"host": "\[redacted\]"/);
  assert.doesNotMatch(text, /192\.0\.2\.10/);
  assert.match(text, /"port": 22000/);
});

test("exported logs redact folder secrets, device identifiers and candidate addresses", () => {
  const state = createInitialState(null);
  const deviceId = "55KM6B52CSRRQAU2L3GEFJBAE6MLYK4BH25GIQW3ULKGAZYHKTGA";
  pushSessionLog(state, "error", "refresh_overview.failed",
    "Could not connect using discovered candidates. " +
    "tcp://192.0.2.10:22000: Connection closed | " +
    "relay://192.0.2.11:22067/?id=ABCDEFG-HIJKLMN-OPQRSTU-VWXYZ23-4567890-ABCDEFG-HIJKLMN-OPQRSTU: closed | " +
    "quic://[fda4:0:0:0:1]:22000: timeout | " +
    `peer ${deviceId}`);
  pushSessionLog(state, "info", "core.untrusted.folder.state", "Folder requires a password.", {
    remoteDeviceId: deviceId,
    connectedHost: "192.0.2.12",
    deviceName: "personal-phone",
    folderPasswords: { camera: "synthetic-folder-password" },
    needsPassword: true,
    hasFolderPassword: false,
    folderPasswordCount: 1,
    passwordError: null,
  });
  const text = formatSessionLogs(appInfo, state.logs.items);
  assert.doesNotMatch(text, /192\.0\.2\.(?:10|11|12)/);
  assert.doesNotMatch(text, /fda4:0:0:0:1/);
  assert.doesNotMatch(text, /ABCDEFG-HIJKLMN/);
  assert.doesNotMatch(text, new RegExp(deviceId));
  assert.doesNotMatch(text, /synthetic-folder-password/);
  assert.doesNotMatch(text, /personal-phone/);
  assert.match(text, /Connection closed/);
  assert.match(text, /"needsPassword": true/);
  assert.match(text, /"hasFolderPassword": false/);
  assert.match(text, /"folderPasswordCount": 1/);
  assert.match(text, /"passwordError": null/);
});

test("copying an oversized log is refused instead of breaking the clipboard", async () => {
  const copied = clipboard();
  const { state, actions } = createFixture();
  // Real messages keep their words: diagnostic text redaction only collapses
  // address/path/token runs, so ordinary prose still exceeds the clipboard guard.
  pushSessionLog(state, "info", "app.personal_space.required",
    "oversized diagnostic text ".repeat(Math.ceil(CLIPBOARD_SESSION_LOG_LIMIT_BYTES / 25) + 64));
  await actions.copySessionLogs();
  assert.equal(copied.length, 0, "The clipboard must not receive a payload larger than the guard.");
  assert.match(state.ui.recentError ?? "", /too large for the clipboard/);
  assert.match(state.ui.recentError ?? "", /Save logs or Share logs/);
});

test("copying a normal log keeps the same text as save and share", async () => {
  const copied = clipboard();
  const { state, actions, calls } = createFixture();
  pushSessionLog(state, "info", "ui.tab.switch", "Switched tab to folders");
  await actions.copySessionLogs();
  assert.equal(copied.length, 1);
  assert.match(copied[0]!, /Switched tab to folders/);
  assert.ok(sessionLogTextSize(copied[0]!) <= CLIPBOARD_SESSION_LOG_LIMIT_BYTES);

  await actions.saveSessionLogs();
  await actions.shareSessionLogs();
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.shared.length, 1);
  assert.match(calls.saved[0]![0], /^syncpeer-logs-.*\.txt$/);
  assert.match(calls.shared[0]![0], /^syncpeer-logs-.*\.txt$/);
  // Each export records itself, so the shared text also contains the earlier save entry.
  assert.match(calls.saved[0]![1], /Switched tab to folders/);
  assert.doesNotMatch(calls.saved[0]![1], /logs\.shared/);
  assert.match(calls.shared[0]![1], /Switched tab to folders/);
  assert.match(calls.shared[0]![1], /logs\.saved/);
});

test("cancelling the save folder picker is not an error", async () => {
  const { state, actions } = createFixture({
    save: async () => null,
    share: async () => undefined,
  });
  await actions.saveSessionLogs();
  assert.equal(state.ui.recentError, null, "Cancelling the picker must not raise a UI error.");
  assert.ok(state.logs.items.some(item => item.event === "logs.save.cancelled"));
  assert.equal(state.logs.items.some(item => item.level === "error"), false);
});

test("log file names are filesystem-safe and sortable", () => {
  const name = sessionLogFileName(new Date("2026-10-22T04:08:29.065Z"));
  assert.equal(name, "syncpeer-logs-2026-10-22T04-08-29-065Z.txt");
  assert.match(name, /^[A-Za-z0-9._-]+$/);
});
