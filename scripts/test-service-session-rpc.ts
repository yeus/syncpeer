import assert from "node:assert/strict";
import test from "node:test";
import { createServiceSessionRpcClient } from "../packages/core/src/sync/serviceSessionRpc.ts";

test("service RPC multiplexes overlapping requests and handles errors", async () => {
  const waits = new Map<string, (value: unknown) => void>();
  const rpc = createServiceSessionRpcClient(async request => await new Promise(resolve => {
    waits.set(String(request.operation), resolve);
  }));
  const one = rpc.call({ operation: "status" });
  const two = rpc.call({ operation: "listFolders" });
  assert.equal(waits.size, 2);
  waits.get("listFolders")?.(["one"]);
  waits.get("status")?.({ phase: "connected" });
  assert.deepEqual(await one, { phase: "connected" });
  assert.deepEqual(await two, ["one"]);
  rpc.close();
});

test("service RPC propagates errors and aborts safely", async () => {
  const rpc = createServiceSessionRpcClient(async request => {
    if (request.operation === "status") throw Error("synthetic session failed");
    return await new Promise(() => undefined);
  });
  await assert.rejects(rpc.call({ operation: "status" }), /synthetic session failed/);
  const controller = new AbortController();
  const operation = rpc.call({ operation: "waitForFolderIndex", folderId: "folder" }, controller.signal);
  controller.abort();
  await assert.rejects(operation, { name: "AbortError" });
  rpc.close();
});
