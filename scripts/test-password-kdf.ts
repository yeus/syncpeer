import assert from "node:assert/strict";
import test from "node:test";
import { scryptPasswordKdf } from "../packages/core/dist/kdf.js";
import { createWorkerPasswordKdf } from "../packages/app/src/lib/passwordKdf.ts";

const withWorker = async (worker: unknown, run: () => Promise<void>) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: worker });
  try { await run(); }
  finally {
    if (original) Object.defineProperty(globalThis, "Worker", original);
    else delete (globalThis as { Worker?: unknown }).Worker;
  }
};

test("password KDF falls back when module workers are unavailable", async () => {
  const password = new TextEncoder().encode("synthetic-password");
  const salt = new TextEncoder().encode("synthetic-folder");
  const expected = await scryptPasswordKdf(password.slice(), salt);
  await withWorker(class { constructor() { throw new TypeError("Module workers are unsupported."); } }, async () => {
    const actual = await createWorkerPasswordKdf()(password.slice(), salt);
    assert.deepEqual(actual, expected);
  });
});

test("password KDF falls back when a module worker cannot load", async () => {
  const password = new TextEncoder().encode("synthetic-password");
  const salt = new TextEncoder().encode("synthetic-folder");
  const expected = await scryptPasswordKdf(password.slice(), salt);
  class FailingWorker {
    onerror: ((event: { message: string }) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { queueMicrotask(() => this.onerror?.({ message: "Module worker failed to load." })); }
    postMessage() {}
    terminate() {}
  }
  await withWorker(FailingWorker, async () => {
    const actual = await createWorkerPasswordKdf()(password.slice(), salt);
    assert.deepEqual(actual, expected);
  });
});
