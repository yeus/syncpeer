import assert from "node:assert/strict";
import test from "node:test";
import { makeWaitForFolderIndexToArriveFlow } from "../packages/core/src/ui/sessionFlows.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const options = { host: "127.0.0.1", port: 22000, deviceName: "fixture" } as never;
const ready = [{ folderId: "folder", remoteIndexId: "1", remoteMaxSequence: "1", indexReceived: true }];

test("slow Android index RPC is not duplicated and its eventual result is accepted", async () => {
  let calls = 0;
  let resolveRequest: (value: typeof ready) => void = () => {};
  const request = new Promise<typeof ready>(resolve => { resolveRequest = resolve; });
  const events: string[] = [];
  const flow = makeWaitForFolderIndexToArriveFlow({ sleep, log: event => events.push(event.event) });
  const pending = flow({ folderId: "folder", connectOptions: options, initialFolderSyncStates: [],
    fetchFolderVersions: () => { calls++; return request; }, requestTimeoutMs: 100, timeoutMs: 400 });
  await sleep(160);
  assert.equal(calls, 1, "Soft timeout must not dispatch an overlapping request.");
  resolveRequest(ready);
  const result = await pending;
  assert.equal(result.received, true);
  assert.equal(calls, 1);
  assert.ok(events.includes("session.flow.folder_index.request_slow"));
  assert.ok(events.includes("session.flow.folder_index.ready"));
});

test("a permanently stalled index request exits within deadline without request storms", async () => {
  let calls = 0;
  const events: string[] = [];
  const flow = makeWaitForFolderIndexToArriveFlow({ sleep, log: event => events.push(event.event) });
  const started = Date.now();
  const result = await flow({ folderId: "folder", connectOptions: options, initialFolderSyncStates: [],
    fetchFolderVersions: () => { calls++; return new Promise(() => undefined); },
    requestTimeoutMs: 100, timeoutMs: 240 });
  assert.equal(result.received, false);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 700);
  assert.deepEqual(events, ["session.flow.folder_index.request_slow", "session.flow.folder_index.unavailable"]);
  assert.equal(result.attempts[0]?.timedOut, true);
});
