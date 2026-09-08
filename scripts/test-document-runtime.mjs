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
    return source[0] === 1 && decoder.decode(new TextEncoder().encode("synthetic")) === "synthetic";
  })()`, context), true);
});
