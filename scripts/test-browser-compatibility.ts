import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { installWebViewCompatibility } from "../packages/core/src/platform/browserCompatibility.ts";

const context = createContext({});
runInContext(`
  Object.hasOwn = undefined;
  Object.fromEntries = undefined;
  Array.prototype.at = undefined;
  String.prototype.replaceAll = undefined;
  Promise.allSettled = undefined;
  Promise.any = undefined;
  globalThis.queueMicrotask = undefined;
  globalThis.structuredClone = undefined;
  globalThis.AggregateError = undefined;
  globalThis.crypto = {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
      return bytes;
    },
  };
  globalThis.AbortSignal = class AbortSignalPolyfillTarget {
    constructor(aborted) { this.aborted = aborted; }
  };
`, context);

installWebViewCompatibility(runInContext("globalThis", context) as typeof globalThis);

const observed = await runInContext(`(async () => {
  const parent = { inherited: true };
  const own = Object.create(parent);
  own.value = 3;
  const settled = await Promise.allSettled([Promise.resolve(7), Promise.reject("failed")]);
  let aggregate;
  try { await Promise.any([Promise.reject("first"), Promise.reject("second")]); }
  catch (error) { aggregate = [error instanceof AggregateError, error.errors.length]; }
  const microtask = await new Promise(resolve => queueMicrotask(() => resolve("ran")));
  const uuid = crypto.randomUUID();
  return JSON.stringify([
    Object.hasOwn(own, "value"), Object.hasOwn(own, "inherited"),
    Object.fromEntries([["a", 1], ["b", 2]]),
    [1, 2, 3].at(-1), "a.b".replaceAll(".", "-"), "a b".replaceAll(/\\s/g, "-"),
    settled.map(value => value.status), aggregate, microtask,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid),
    (() => {
      const original = { value: 3, bytes: new Uint8Array([1, 2]) };
      const clone = structuredClone(original);
      original.bytes[0] = 9;
      return [clone.value, clone.bytes[0], original.bytes[0]];
    })(),
    (() => { const signal = new AbortSignal(false); signal.throwIfAborted(); return "live"; })(),
    (() => { const signal = new AbortSignal(true); try { signal.throwIfAborted(); } catch (error) { return [error.name, error.message]; } })(),
  ]);
})()`, context) as string;

assert.equal(observed, JSON.stringify([
  true, false, { a: 1, b: 2 }, 3, "a-b", "a-b", ["fulfilled", "rejected"], [true, 2], "ran", true,
  [3, 1, 9], "live",
  ["AbortError", "The operation was aborted."],
]));

console.log("browser compatibility polyfills passed");
