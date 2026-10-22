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

test("copying an oversized log is refused instead of breaking the clipboard", async () => {
  const copied = clipboard();
  const { state, actions } = createFixture();
  pushSessionLog(state, "info", "app.personal_space.required",
    "x".repeat(CLIPBOARD_SESSION_LOG_LIMIT_BYTES + 1024));
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

test("log file names are filesystem-safe and sortable", () => {
  const name = sessionLogFileName(new Date("2026-10-22T04:08:29.065Z"));
  assert.equal(name, "syncpeer-logs-2026-10-22T04-08-29-065Z.txt");
  assert.match(name, /^[A-Za-z0-9._-]+$/);
});
