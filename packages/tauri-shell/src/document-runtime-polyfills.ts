import { TextEncoder as PolyfillTextEncoder, TextDecoder as PolyfillTextDecoder } from "@kayahr/text-encoding/no-encodings";
import polyfillStructuredClone from "@ungap/structured-clone";
import { AbortController as PolyfillAbortController, AbortSignal as PolyfillAbortSignal } from "abort-controller";
import { fromByteArray, toByteArray } from "base64-js";
import { createPortRequest, type RuntimePort } from "./document-runtime-port.js";

type AndroidTimerRuntime = { getNamedPort: (name: string) => Promise<RuntimePort> };

const encodeBase64 = (value: string) => {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 255) throw new Error("Invalid base64 source character.");
    bytes[index] = code;
  }
  return fromByteArray(bytes);
};

const decodeBase64 = (value: string) => {
  const bytes = toByteArray(value);
  let decoded = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    decoded += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return decoded;
};

// This isolated entry executes before core's dependencies construct text codecs.
if (typeof globalThis.TextEncoder !== "function") globalThis.TextEncoder = PolyfillTextEncoder;
if (typeof globalThis.TextDecoder !== "function") globalThis.TextDecoder = PolyfillTextDecoder;
if (typeof globalThis.btoa !== "function") globalThis.btoa = encodeBase64;
if (typeof globalThis.atob !== "function") globalThis.atob = decodeBase64;
if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = polyfillStructuredClone as typeof globalThis.structuredClone;
}
if (typeof globalThis.AbortController !== "function" || typeof globalThis.AbortSignal !== "function") {
  Object.assign(globalThis, { AbortController: PolyfillAbortController, AbortSignal: PolyfillAbortSignal });
}
if (!("throwIfAborted" in AbortSignal.prototype)) Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
  value(this: AbortSignal) { if (this.aborted) throw new Error("Operation cancelled."); },
});

export const installAndroidTimers = async (android: AndroidTimerRuntime) => {
  if (typeof globalThis.setTimeout === "function" && typeof globalThis.clearTimeout === "function" &&
    typeof globalThis.setInterval === "function" && typeof globalThis.clearInterval === "function") return;
  const request = createPortRequest(await android.getNamedPort("timer"));
  let nextId = 0;
  const active = new Map<number, { callback: (...args: unknown[]) => void; args: unknown[]; delayMs: number; repeat: boolean }>();
  const run = async (id: number): Promise<void> => {
    const timer = active.get(id);
    if (!timer) return;
    await request({ operation: "sleep", delayMs: timer.delayMs });
    if (active.get(id) !== timer) return;
    if (!timer.repeat) active.delete(id);
    timer.callback(...timer.args);
    if (timer.repeat && active.get(id) === timer) void run(id);
  };
  const schedule = (callback: (...args: unknown[]) => void, delay: number | undefined,
    args: unknown[], repeat: boolean) => {
    if (typeof callback !== "function") throw new TypeError("Timer callback must be a function.");
    const id = ++nextId;
    active.set(id, { callback, args, delayMs: Math.max(0, Number(delay) || 0), repeat });
    void run(id);
    return id;
  };
  const clear = (id: number | undefined) => { if (id !== undefined) active.delete(Number(id)); };
  const setTimeoutPolyfill = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    schedule(callback, delay, args, false);
  const setIntervalPolyfill = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    schedule(callback, delay, args, true);
  globalThis.setTimeout = setTimeoutPolyfill as typeof setTimeout;
  globalThis.setInterval = setIntervalPolyfill as typeof setInterval;
  globalThis.clearTimeout = clear as typeof clearTimeout;
  globalThis.clearInterval = clear as typeof clearInterval;
};
