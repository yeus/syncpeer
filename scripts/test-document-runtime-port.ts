import assert from "node:assert/strict";
import test from "node:test";
import { createPortRequest, type RuntimePort } from "../packages/tauri-shell/src/document-runtime-port.ts";

test("port correlation ID cannot overwrite an operation's UUID ID", async () => {
  const sent: Record<string, unknown>[] = [];
  const port: RuntimePort = {
    onmessage: null,
    postMessage: raw => { sent.push(JSON.parse(String(raw))); },
  };
  const request = createPortRequest(port);
  const jobId = "6a6867aa-005e-4749-aad1-a188e176bad5";
  const first = request({ operation: "transferJobProgress", id: jobId, phase: "queued" });
  const second = request({ operation: "status" });

  assert.equal(sent[0].id, jobId);
  assert.equal(sent[0].__portId, 1);
  assert.equal(sent[1].__portId, 2);
  assert.equal(Object.hasOwn(sent[1], "id"), false);

  port.onmessage?.({ data: JSON.stringify({ id: 2, result: "second" }) } as MessageEvent);
  port.onmessage?.({ data: JSON.stringify({ id: 1, result: { phase: "queued" } }) } as MessageEvent);
  assert.equal(await second, "second");
  assert.deepEqual(await first, { phase: "queued" });
});

test("transport-generated correlation ID cannot be overridden by an operation payload", async () => {
  const port: RuntimePort = {
    onmessage: null,
    postMessage: raw => {
      const message = JSON.parse(String(raw));
      assert.equal(message.__portId, 1);
      port.onmessage?.({ data: JSON.stringify({ id: 1, error: "Native failure" }) } as MessageEvent);
    },
  };
  await assert.rejects(createPortRequest(port)({ __portId: "spoofed", id: "job-id" }), /Native failure/);
});
