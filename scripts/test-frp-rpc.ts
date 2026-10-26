import assert from "node:assert/strict";
import test from "node:test";
import { createDuplexChannel } from "../packages/core/src/transfer/frpBus.ts";
import { createStreamRpcRequest } from "../packages/core/src/transfer/frpRpc.ts";

type Message = { type: "request" | "reply" | "cancel"; requestId: string; result?: number; reason?: string };
const call = (port: ReturnType<typeof createDuplexChannel<Message>>["x"], id: string, signal?: AbortSignal, timeoutMs = 200) =>
  createStreamRpcRequest<Message, Message, number, never, Message>({
    port, request: { type: "request", requestId: id }, requestId: id,
    timeoutMs, signal,
    createCancelRequest: reason => ({ type: "cancel", requestId: id, reason }),
    parseResponse: message => message.type === "reply" ? message : undefined,
    isResponseForRequest: (response, requestId) => response.requestId === requestId,
    readResponse: response => ({ ok: true, value: response.result ?? 0 }),
  });

test("Taskyon FRPBus RPC correlates concurrent replies and disposes listeners", async () => {
  const ports = createDuplexChannel<Message>();
  const pending: string[] = [];
  const stop = ports.y.receive(message => {
    if (message.type !== "request") return;
    pending.push(message.requestId);
    if (pending.length === 2) {
      ports.y.send({ type: "reply", requestId: pending[1]!, result: 2 });
      ports.y.send({ type: "reply", requestId: pending[0]!, result: 1 });
    }
  });
  assert.deepEqual(await Promise.all([call(ports.x, "a"), call(ports.x, "b")]), [1, 2]);
  stop();
});

test("Taskyon FRPBus RPC propagates cancellation and timeout", async () => {
  const ports = createDuplexChannel<Message>();
  const messages: Message[] = [];
  ports.y.receive(message => { messages.push(message); });
  const controller = new AbortController();
  const cancelled = call(ports.x, "cancel-me", controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  await assert.rejects(call(ports.x, "timeout-me", undefined, 5), { name: "TimeoutError" });
  assert.deepEqual(messages.filter(message => message.type === "cancel").map(message => message.requestId),
    ["cancel-me", "timeout-me"]);
});
