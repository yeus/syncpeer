import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { installWebViewCompatibility } from "../packages/core/src/platform/browserCompatibility.ts";

const context = createContext({});
runInContext(`
  Object.hasOwn = undefined;
  Array.prototype.at = undefined;
  String.prototype.replaceAll = undefined;
  Promise.allSettled = undefined;
  Promise.any = undefined;
  globalThis.structuredClone = undefined;
  globalThis.AggregateError = undefined;
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
  return JSON.stringify([
    Object.hasOwn(own, "value"), Object.hasOwn(own, "inherited"),
    [1, 2, 3].at(-1), "a.b".replaceAll(".", "-"), "a b".replaceAll(/\\s/g, "-"),
    settled.map(value => value.status), aggregate,
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
  true, false, 3, "a-b", "a-b", ["fulfilled", "rejected"], [true, 2], [3, 1, 9], "live",
  ["AbortError", "The operation was aborted."],
]));

console.log("browser compatibility polyfills passed");
