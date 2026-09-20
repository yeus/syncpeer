import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import test from "node:test";

test("packaged document core boots without browser globals and retains strict UTF-8", async () => {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "packages/tauri-shell/tsconfig.documents.json"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-document-runtime.mjs"], { stdio: "pipe" });
  const code = await fs.readFile("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/build/generated/document-runtime/assets/syncpeer-documents.js", "utf8");
  const context = vm.createContext({});
  assert.equal(await vm.runInContext(code, context), "ready");
  assert.equal(vm.runInContext(`(() => {
    const decoder = new TextDecoder("utf-8", {fatal:true});
    try { decoder.decode(new Uint8Array([255])); return false; } catch {}
    const source = new Uint8Array([1, 2]); const copy = structuredClone(source); copy[0] = 9;
    const controller = new AbortController(); controller.abort();
    try { controller.signal.throwIfAborted(); return false; } catch {}
    return source[0] === 1 && decoder.decode(new TextEncoder().encode("synthetic")) === "synthetic" &&
      atob(btoa("base64 fixture")) === "base64 fixture";
  })()`, context), true);
});

test("packaged document core preserves a browser's native structured clone", async () => {
  execFileSync(process.execPath, ["scripts/build-document-runtime.mjs"], { stdio: "pipe" });
  const code = await fs.readFile("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/build/generated/document-runtime/assets/syncpeer-documents.js", "utf8");
  const nativeStructuredClone = globalThis.structuredClone;
  const context = vm.createContext({ structuredClone: nativeStructuredClone });
  assert.equal(await vm.runInContext(code, context), "ready");
  assert.equal(context.structuredClone, nativeStructuredClone);
  const copy = vm.runInContext("structuredClone({ value: 7 })", context);
  assert.equal(copy.value, 7);
});

test("packaged document core installs timers through the Android runtime", async () => {
  execFileSync(process.execPath, ["scripts/build-document-runtime.mjs"], { stdio: "pipe" });
  const code = await fs.readFile("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/build/generated/document-runtime/assets/syncpeer-documents.js", "utf8");
  const context = vm.createContext({});
  assert.equal(await vm.runInContext(code, context), "ready");
  const timerPort = {
    onmessage: null,
    postMessage(raw) {
      const request = JSON.parse(raw);
      globalThis.setTimeout(() => this.onmessage({ data: JSON.stringify({ id: request.id, result: null }) }), request.delayMs);
    },
  };
  await context.syncpeerDocumentsCore.installAndroidTimers({
    getNamedPort: async (name) => {
      assert.equal(name, "timer");
      return timerPort;
    },
  });
  assert.equal(await vm.runInContext(`new Promise(resolve => {
    let calls = 0;
    const interval = setInterval(() => {
      calls += 1;
      if (calls === 2) { clearInterval(interval); resolve(calls); }
    }, 1);
  })`, context), 2);
});
