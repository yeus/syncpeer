import assert from "node:assert/strict";
import test from "node:test";
import { createPersistentSessionLogs } from "../packages/app/src/app/sessionLogPersistence.ts";
import { createInitialState, observeSessionLogs, pushSessionLog } from "../packages/app/src/app/state.ts";
import { createAppBuildInfo } from "../packages/core/src/browser.ts";
import { formatSessionLogs } from "../packages/app/src/app/sessionLogs.ts";

const first = "11111111-1111-1111-1111-111111111111";
const second = "22222222-2222-2222-2222-222222222222";

const fixture = () => {
  const entries: Array<Record<string, unknown>> = [];
  let failAppend = false;
  const port = async (request: Record<string, unknown>): Promise<unknown> => {
    const operation = request.operation;
    if (operation === "start") {
      const runId = String(request.runId);
      const previousRuns = [...new Set(entries.map(value => String(value.runId)))]
        .filter(id => id !== runId).reverse().map(id => ({
          runId: id, startedAtMs: Number(entries.find(value => value.runId === id)?.timestampMs) || 0,
        }));
      if (!entries.some(value => value.runId === runId)) {
        entries.push({ runId, timestampMs: Date.now(), level: "info",
          event: "app.run.started", message: "Syncpeer process started." });
      }
      return { started: true, previousRuns };
    }
    if (operation === "append") {
      if (failAppend) { failAppend = false; throw new Error("simulated interrupted storage"); }
      const items = request.items as Array<Record<string, unknown>>;
      assert.ok(items.length <= 24);
      entries.push(...items);
      return { saved: items.length };
    }
    if (operation === "read") {
      const values = entries.filter(item => item.runId === request.runId);
      return { total: values.length,
        items: values.slice(Number(request.offset), Number(request.offset) + Number(request.limit)) };
    }
    throw new Error("Unknown diagnostic command.");
  };
  return { entries, port, failNextAppend: () => { failAppend = true; } };
};

test("E2E log stream and native journal can observe the same events independently", () => {
  const state = createInitialState(null);
  const journal: string[] = [], e2e: string[] = [];
  const stopJournal = observeSessionLogs(state, entry => { journal.push(entry.event); });
  const stopE2e = observeSessionLogs(state, entry => { e2e.push(entry.event); });
  pushSessionLog(state, "info", "client.shared_folders.selected", "Synthetic folder selection.");
  stopE2e();
  pushSessionLog(state, "warning", "core.replica.index.decision", "Synthetic replica index.");
  assert.deepEqual(journal, ["client.shared_folders.selected", "core.replica.index.decision"]);
  assert.deepEqual(e2e, ["client.shared_folders.selected"]);
  stopJournal();
});

test("two app runs restore previous crash logs and sanitize secrets before durable storage", async () => {
  const native = fixture();
  const app = createInitialState(null);
  const history = createPersistentSessionLogs({ port: native.port, runId: first });
  const unsubscribe = observeSessionLogs(app, history.record);
  pushSessionLog(app, "warning", "early.startup", "Startup while native bridge is loading.");
  await history.start();
  pushSessionLog(app, "error", "ui.crash", "Failure at tcp://192.0.2.42:22000", {
    folderPasswords: { keepass: "my-secret-password" }, host: "192.0.2.42",
    needsPassword: true, reason: "file:///private/somewhere/keys",
  });
  await history.flush();
  history.dispose();
  unsubscribe();

  const stored = JSON.stringify(native.entries);
  assert.doesNotMatch(stored, /my-secret-password|192\.0\.2\.42|\/private\/somewhere/);
  assert.match(stored, /\[redacted\]/);
  assert.equal(native.entries.filter(item => item.runId === first).length, 3);

  let recovered: { startedAtMs: number; items: Array<{ event: string; message: string; details?: unknown }> } | undefined;
  const restart = createPersistentSessionLogs({
    port: native.port, runId: second,
    onRestored: previous => { recovered = previous; },
  });
  await restart.start();
  assert.equal(recovered?.items.length, 3);
  assert.equal(recovered?.items[0]?.event, "ui.crash");
  assert.match(recovered?.items[0]?.message ?? "", /\[redacted\]/);

  const exportText = formatSessionLogs(createAppBuildInfo({
    appVersion: "test", coreVersion: "test", buildCommit: "test", buildTimeUtc: "",
    buildMode: "test", runtimeEnvironment: "tauri", runtimeSurface: "android-ui",
    platform: "android", architecture: "arm64", osVersion: "test",
  }), [], { startedAtMs: recovered!.startedAtMs, items: recovered!.items });
  assert.match(exportText, /# Previous Run Logs/);
  assert.match(exportText, /ui\.crash/);
  assert.doesNotMatch(exportText, /my-secret-password/);
  restart.dispose();
});

test("interrupted native append is retried without losing the buffered batch", async () => {
  const native = fixture();
  const history = createPersistentSessionLogs({ port: native.port, runId: first });
  await history.start();
  history.record({ timestampMs: Date.now(), level: "error", event: "test.crash", message: "Crash marker" });
  native.failNextAppend();
  await history.flush();
  assert.equal(history.pending(), 1);
  await history.flush();
  assert.equal(history.pending(), 0);
  assert.ok(native.entries.some(entry => entry.event === "test.crash"));
  history.dispose();
});

test("reads paginated previous runs beyond one Android Binder result", async () => {
  const native = fixture();
  const history = createPersistentSessionLogs({ port: native.port, runId: first });
  await history.start();
  for (let i = 0; i < 215; i++) history.record({
    timestampMs: Date.now() + i, level: "info", event: "test.progress", message: "log " + i,
  });
  // Flush all queued entries without waiting for the ordinary debounce window.
  for (let i = 0; i < 10 && history.pending(); i++) {
    await history.flush();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(history.pending(), 0);
  history.dispose();
  let restored = 0;
  const restarted = createPersistentSessionLogs({ port: native.port, runId: second,
    onRestored: value => { restored = value.items.length; } });
  await restarted.start();
  assert.equal(restored, 216);
  restarted.dispose();
});

test("Android abnormal previous-process exit is visible immediately after restart", async () => {
  const native = fixture();
  let exitEvent: { event: string; details?: unknown } | null = null;
  const history = createPersistentSessionLogs({
    runId: second,
    port: async request => request.operation === "start"
      ? { started: true, previousRuns: [], previousExit: {
          runId: second, timestampMs: Date.now(), level: "error",
          event: "native.previous_process_exit",
          message: "Android recorded an abnormal previous Syncpeer process exit.",
          details: JSON.stringify({ reasonCode: 3, rssKb: 400000 }),
        } }
      : native.port(request),
    onNativeExit: event => { exitEvent = event; },
  });
  await history.start();
  assert.equal(exitEvent?.event, "native.previous_process_exit");
  assert.deepEqual(exitEvent?.details, { reasonCode: 3, rssKb: 400000 });
  assert.equal(history.pending(), 0, "Already-persisted OS crash diagnostics cannot be duplicated.");
  history.dispose();
});
test("history is deferred during startup and restores multiple older runs on demand", async () => {
  const native = fixture();
  const third = "33333333-3333-3333-3333-333333333333";
  let listCalls = 0;
  let readCalls = 0;
  const port = async (request: Record<string, unknown>) => {
    if (request.operation === "start") {
      await native.port(request);
      return { started: true };
    }
    if (request.operation === "list") {
      listCalls++;
      const ids = [...new Set(native.entries.map(item => String(item.runId)))];
      return { runs: ids.map(id => {
        const matching = native.entries.filter(item => item.runId === id);
        return { runId: id, startedAtMs: Number(matching[0]?.timestampMs) || 0,
          lastEventAtMs: Number(matching.at(-1)?.timestampMs) || 0, count: matching.length };
      }) };
    }
    if (request.operation === "read") readCalls++;
    return native.port(request);
  };
  const firstRun = createPersistentSessionLogs({ port, runId: first, deferHistory: true });
  await firstRun.start();
  firstRun.record({ timestampMs: 1000, level: "error", event: "first.failure", message: "run one" });
  await firstRun.flush();
  firstRun.dispose();
  const secondRun = createPersistentSessionLogs({ port, runId: second, deferHistory: true });
  await secondRun.start();
  secondRun.record({ timestampMs: 2000, level: "warning", event: "second.problem", message: "run two" });
  await secondRun.flush();
  secondRun.dispose();
  let recovered: Array<{ event: string }> = [];
  const finalRun = createPersistentSessionLogs({ port, runId: third, deferHistory: true,
    onRestored: value => { recovered = value.items; } });
  await finalRun.start();
  assert.equal(listCalls, 0, "Startup must not scan/decrypt archived records.");
  assert.equal(readCalls, 0);
  finalRun.record({ timestampMs: 3000, level: "error", event: "current.error", message: "now" });
  await finalRun.flush();
  await Promise.all([finalRun.restore(), finalRun.restore()]);
  assert.equal(listCalls, 1, "Concurrent history openings share one listing.");
  assert.ok(readCalls >= 2);
  assert.ok(recovered.some(item => item.event === "first.failure"));
  assert.ok(recovered.some(item => item.event === "second.problem"));
  assert.ok(!recovered.some(item => item.event === "current.error"),
    "The current run is separate from archived history.");
  finalRun.dispose();
});

test("the last crash stays first even when all archived events have identical timestamps", async () => {
  const native = fixture();
  const start = createPersistentSessionLogs({ port: native.port, runId: first });
  await start.start();
  for (const event of ["first.step", "second.step", "last.crash"]) {
    start.record({ timestampMs: 123456, level: event === "last.crash" ? "error" : "info",
      event, message: event });
  }
  await start.flush();
  start.dispose();
  let events: string[] = [];
  const restart = createPersistentSessionLogs({ port: native.port, runId: second,
    onRestored: value => { events = value.items.map(item => item.event); } });
  await restart.start();
  assert.deepEqual(events.slice(0, 3), ["last.crash", "second.step", "first.step"]);
  restart.dispose();
});
test("unacknowledged native appends are retained for retry instead of being silently dropped", async () => {
  const native = fixture();
  let partial = true;
  const history = createPersistentSessionLogs({
    runId: first,
    port: async request => {
      if (request.operation === "append" && partial) {
        partial = false;
        return { saved: 0 };
      }
      return native.port(request);
    },
  });
  await history.start();
  history.record({ timestampMs: Date.now(), level: "error",
    event: "log.must_survive", message: "important failure" });
  await history.flush();
  assert.equal(history.pending(), 1, "Unacknowledged record must remain queued.");
  await history.flush();
  assert.equal(history.pending(), 0);
  assert.ok(native.entries.some(item => item.event === "log.must_survive"));
  history.dispose();
});

test("explicit export includes current-run native network trace, not just archived runs", async () => {
  const native = fixture();
  const current = createPersistentSessionLogs({
    runId: first,
    port: request => {
      if (request.operation === "list") {
        return { runs: [
          { runId: first, count: native.entries.filter(e => e.runId === first).length },
          { runId: second, count: native.entries.filter(e => e.runId === second).length },
        ] };
      }
      if (request.operation === "release") return { released: true };
      return native.port(request);
    },
    deferHistory: true,
  });
  await current.start();
  const entries = [
    { runId: first, timestampMs: 1000, level: "warning", event: "native.network.operation_slow",
      message: "native.network.operation_slow", details: JSON.stringify({
        operation: "tlsOpen", durationMs: 8000, failed: true }) },
    { runId: first, timestampMs: 1001, level: "warning", event: "core.discovery.candidate.failed",
      message: "core.discovery.candidate.failed", details: JSON.stringify({
        protocol: "tcp", source: "local", category: "timeout", addressFamily: "ipv4" }) },
    { runId: first, timestampMs: 1002, level: "info", event: "peer.connect.attempt_started",
      message: "Already visible through the WebView observer." },
    { runId: second, timestampMs: 1003, level: "warning", event: "native.network.operation_slow",
      message: "native.network.operation_slow" },
  ];
  await native.port({ operation: "append", items: entries });
  const trace = await current.readCurrentNativeTrace();
  assert.deepEqual(trace.map(x => x.event),
    ["native.network.operation_slow", "core.discovery.candidate.failed"]);
  assert.deepEqual((trace[0].details as Record<string, unknown>).operation, "tlsOpen");
  assert.deepEqual((trace[1].details as Record<string, unknown>).source, "local");
  current.dispose();
});

test("focused peer support bundle pages only the recent native tail", async () => {
  const events = Array.from({ length: 1200 }, (_, i) => ({
    runId: first, timestampMs: i, level: "info",
    event: "native.network.operation_slow", message: "synthetic event",
  }));
  const reads: Array<[number, number]> = [];
  const history = createPersistentSessionLogs({
    runId: first, deferHistory: true,
    port: async request => {
      if (request.operation === "start") return { started: true };
      if (request.operation === "list") return { runs: [{ runId: first, count: events.length }] };
      if (request.operation === "release") return { released: true };
      if (request.operation === "read") {
        const offset = Number(request.offset), limit = Number(request.limit);
        reads.push([offset, limit]);
        return { items: events.slice(offset, offset + limit) };
      }
      return { saved: 0 };
    },
  });
  await history.start();
  const focused = await history.readCurrentNativeTrace(225);
  assert.equal(focused.length, 225);
  assert.equal(focused[0]?.timestampMs, 975);
  assert.deepEqual(reads, [[975, 100], [1075, 100], [1175, 25]]);
  reads.length = 0;
  const full = await history.readCurrentNativeTrace();
  assert.equal(full.length, 1200);
  assert.equal(reads.length, 12);
  history.dispose();
});

test("Android in-memory native tail exports without decrypting or listing the journal", async () => {
  const native = fixture();
  let listOrRead = 0;
  const history = createPersistentSessionLogs({
    runId: first, deferHistory: true,
    port: async request => {
      if (request.operation === "recentNative") {
        assert.equal(request.runId, first);
        assert.equal(request.limit, 400);
        return { items: [{ runId: first, timestampMs: 1000, level: "error",
          event: "native.document.storage_failed",
          message: "native.document.storage_failed",
          details: JSON.stringify({ failureCategory: "metadata-database", operation: "register" }) }] };
      }
      if (request.operation === "list" || request.operation === "read") {
        listOrRead++;
        throw new Error("Must not decrypt the old journal for a current native trace.");
      }
      return native.port(request);
    },
  });
  await history.start();
  const recent = await history.readCurrentNativeTrace(400);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.event, "native.document.storage_failed");
  assert.equal((recent[0]?.details as Record<string, unknown>)?.failureCategory, "metadata-database");
  assert.equal(listOrRead, 0);
  history.dispose();
});

test("regular export takes bounded prior-run tail without a historical journal scan", async () => {
  const native = fixture();
  let calls = 0;
  let restored: Array<{ event: string }> = [];
  const history = createPersistentSessionLogs({
    runId: first, deferHistory: true,
    onRestored: value => { restored = value.items; },
    port: async request => {
      if (request.operation === "recentHistory") {
        assert.equal(request.limit, 160);
        return { items: [
          { runId: second, timestampMs: 1200, level: "warning",
            event: "native.previous_process_exit", message: "Crash" },
          { runId: second, timestampMs: 1100, level: "info",
            event: "native.runtime.initialize.stage", message: "Startup" },
        ], startedAtMs: 1100, truncated: true };
      }
      if (request.operation === "list" || request.operation === "read") {
        calls++;
        throw new Error("Unexpected full historical decrypt.");
      }
      return native.port(request);
    },
  });
  await history.start();
  await history.readRecentHistory();
  assert.equal(calls, 0);
  assert.deepEqual(restored.map(item => item.event), [
    "native.previous_process_exit", "native.runtime.initialize.stage",
  ]);
  history.dispose();
});

test("export flush drains all queued diagnostics instead of just one native page", async () => {
  const native = fixture();
  const history = createPersistentSessionLogs({ port: native.port, runId: first, deferHistory: true });
  await history.start();
  for (let i = 0; i < 61; i++) history.record({
    timestampMs: Date.now() + i, level: "info", event: "export.current", message: `item-${i}`,
  });
  await history.flushAll();
  assert.equal(history.pending(), 0);
  assert.equal(native.entries.filter(item => item.event === "export.current").length, 61);
  history.dispose();
});

test("export readiness marker is durably flushed before asserting journal persistence", async () => {
  const native = fixture();
  const state = createInitialState(null);
  const history = createPersistentSessionLogs({ port: native.port, runId: first, deferHistory: true });
  const stop = observeSessionLogs(state, history.record);
  try {
    await history.start();
    pushSessionLog(state, "info", "diagnostics.export.requested", "Preparing export.");
    await history.flushAll();
    assert.equal(history.pending(), 0);
    pushSessionLog(state, "info", "diagnostics.export.history_ready", "History loaded.");
    assert.equal(history.pending(), 1, "The export-ready marker itself creates a pending write.");
    await history.flushAll();
    assert.equal(history.pending(), 0, "Only post-marker flush confirms the exported journal is current.");
    assert.ok(native.entries.some(entry => entry.event === "diagnostics.export.history_ready"));
  } finally { stop(); history.dispose(); }
});

test("export flush stops after an unacknowledged native append and can retry later", async () => {
  const native = fixture();
  const history = createPersistentSessionLogs({ port: native.port, runId: first, deferHistory: true });
  await history.start();
  for (let i = 0; i < 30; i++) history.record({
    timestampMs: Date.now() + i, level: "error", event: "export.retry", message: "retry",
  });
  native.failNextAppend();
  await history.flushAll();
  assert.equal(history.pending(), 30, "A failed native write must not spin or discard diagnostics.");
  await history.flushAll();
  assert.equal(history.pending(), 0);
  history.dispose();
});

test("invalid startup and history IPC responses are errors, not empty recovered logs", async () => {
  const invalidStart = createPersistentSessionLogs({
    runId: first, port: async () => ({ result: { started: true } }),
  });
  await assert.rejects(invalidStart.start(), /did not confirm initialization/);
  invalidStart.dispose();
  const invalidList = createPersistentSessionLogs({
    runId: first,
    port: async request => request.operation === "start"
      ? { started: true } : {},
    deferHistory: true,
  });
  await invalidList.start();
  await assert.rejects(invalidList.restore(), /no valid historical run listing/);
  invalidList.dispose();
});

test("the native Android process identifier is reported without being persisted as a secret", async () => {
  let observed: number | null = null;
  const history = createPersistentSessionLogs({
    runId: first,
    port: async request => request.operation === "start"
      ? { started: true, nativePid: 12345, previousRuns: [] } : fixture().port(request),
    onStarted: value => { observed = value.nativePid; },
    deferHistory: true,
  });
  await history.start();
  assert.equal(observed, 12345);
  history.dispose();
});
