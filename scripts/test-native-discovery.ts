import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { createNativeDiscoveryFetch } from "../packages/core/dist/sync/nativeDiscovery.js";
import { createPortRequest, type RuntimePort } from "../packages/tauri-shell/src/document-runtime-port.ts";
import { createTauriAdapters } from "../packages/app/src/lib/tauriAdapters.ts";

function installBridge(finishFetchOnCancel = true) {
  const scope = globalThis as typeof globalThis & { __TAURI__?: unknown };
  const previous = scope.__TAURI__;
  const fetching = Promise.withResolvers<void>();
  const result = Promise.withResolvers<unknown>();
  const prepared = Promise.withResolvers<number>();
  const cancellations: number[] = [];
  let preparations = 0;
  const invoke = async (command: string, args?: { request?: { requestId?: number } }) => {
    if (command === "syncpeer_discovery_prepare") { preparations++; return prepared.promise; }
    if (command === "syncpeer_discovery_cancel") {
      cancellations.push(args!.request!.requestId!);
      if (finishFetchOnCancel) result.reject(new Error("Discovery request cancelled")); return;
    }
    assert.equal(command, "syncpeer_discovery_fetch");
    assert.equal(args?.request?.requestId, 7, "Native fetch must own a prepared cancellation handle");
    fetching.resolve(); return result.promise;
  };
  scope.__TAURI__ = { core: { invoke } };
  return { invoke, fetching, result, prepared, cancellations, preparations: () => preparations,
    restore: () => { scope.__TAURI__ = previous; } };
}

test("desktop discovery forwards cancellation to its prepared native request", async () => {
  const bridge = installBridge();
  const stop = new AbortController();
  try {
    bridge.prepared.resolve(7);
    const pending = createTauriAdapters().hostAdapter.discoveryFetch("https://synthetic.invalid/v2/", { signal: stop.signal });
    const rejected = assert.rejects(pending, /cancelled/);
    await bridge.fetching.promise; stop.abort(); await rejected;
    assert.deepEqual(bridge.cancellations, [7]);
    assert.equal(getEventListeners(stop.signal, "abort").length, 0);
  } finally { bridge.restore(); }
});

test("cancellation during native preparation reaches the handle before network I/O", async () => {
  const bridge = installBridge();
  const stop = new AbortController();
  try {
    const pending = createTauriAdapters().hostAdapter.discoveryFetch("https://synthetic.invalid/v2/", { signal: stop.signal });
    const rejected = assert.rejects(pending, /cancelled/);
    stop.abort(); bridge.prepared.resolve(7); await rejected;
    assert.deepEqual(bridge.cancellations, [7]);
  } finally { bridge.restore(); }
});

test("an already cancelled discovery call never allocates a native request", async () => {
  const bridge = installBridge();
  const stop = new AbortController(); stop.abort();
  try {
    await assert.rejects(createTauriAdapters().hostAdapter.discoveryFetch("https://synthetic.invalid/v2/", { signal: stop.signal }), /cancelled/);
    assert.equal(bridge.preparations(), 0);
  } finally { bridge.restore(); }
});


test("Android network port forwards discovery cancellation through the shared native lifecycle", async () => {
  const bridge = installBridge();
  const stop = new AbortController();
  const port: RuntimePort = { onmessage: null, postMessage: raw => {
    const { id, operation, ...request } = JSON.parse(String(raw));
    const command = { discoveryPrepare: "syncpeer_discovery_prepare", discoveryFetch: "syncpeer_discovery_fetch",
      discoveryCancel: "syncpeer_discovery_cancel" }[operation as "discoveryPrepare" | "discoveryFetch" | "discoveryCancel"];
    void bridge.invoke(command, { request }).then(result =>
      port.onmessage?.({ data: JSON.stringify({ id, result }) } as MessageEvent), error =>
      port.onmessage?.({ data: JSON.stringify({ id, error: error.message }) } as MessageEvent));
  } };
  try {
    bridge.prepared.resolve(7);
    const pending = createNativeDiscoveryFetch(createPortRequest(port))("https://synthetic.invalid/v2/", { signal: stop.signal });
    const rejected = assert.rejects(pending, /cancelled/);
    await bridge.fetching.promise; stop.abort(); await rejected;
    assert.deepEqual(bridge.cancellations, [7]);
    assert.equal(getEventListeners(stop.signal, "abort").length, 0);
  } finally { bridge.restore(); }
});

test("finished native discovery detaches cancellation and preserves response headers", async () => {
  const bridge = installBridge();
  const stop = new AbortController();
  try {
    bridge.prepared.resolve(7);
    bridge.result.resolve({ status: 204, body: "", headers: { "reannounce-after": "1800" } });
    const response = await createTauriAdapters().hostAdapter.discoveryFetch("https://synthetic.invalid/v2/", { signal: stop.signal });
    assert.equal(response.headers?.["reannounce-after"], "1800");
    assert.equal(getEventListeners(stop.signal, "abort").length, 0);
    stop.abort(); assert.equal(bridge.cancellations.length, 0);
  } finally { bridge.restore(); }
});


test("acknowledged native cancellation ends discovery even when the fetch reply is queued", async () => {
  const bridge = installBridge(false);
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    bridge.prepared.resolve(7);
    const pending = createTauriAdapters().hostAdapter.discoveryFetch("https://synthetic.invalid/v2/", { signal: stop.signal });
    const rejected = assert.rejects(pending, /cancelled/);
    await bridge.fetching.promise; stop.abort();
    await Promise.race([rejected, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Shutdown waited for a queued native reply")), 250);
    })]);
    assert.deepEqual(bridge.cancellations, [7]);
    assert.equal(getEventListeners(stop.signal, "abort").length, 0);
  } finally { clearTimeout(timer); bridge.result.resolve({ status: 204, body: "", headers: {} }); bridge.restore(); }
});
