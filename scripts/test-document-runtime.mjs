import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { parse } from "acorn";
import test from "node:test";

test("packaged document core boots without browser globals and retains strict UTF-8", async () => {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "packages/tauri-shell/tsconfig.documents.json"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-document-runtime.mjs"], { stdio: "pipe" });
  const code = await fs.readFile("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/build/generated/document-runtime/assets/syncpeer-documents.js", "utf8");
  const context = vm.createContext({ SharedArrayBuffer: undefined });
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
  assert.equal(vm.runInContext(`(() => {
    const endpoint = new URL("https://relay.example.test:443/endpoint?id=identity");
    if (endpoint.hostname !== "relay.example.test" || endpoint.protocol !== "https:" ||
        endpoint.pathname !== "/endpoint" || endpoint.searchParams.get("id") !== "identity") return false;
    endpoint.searchParams.delete("id");
    return endpoint.toString() === "https://relay.example.test/endpoint";
  })()`, context), true, "service-owned discovery requires WHATWG URL APIs without browser globals");
});

test("packaged document core preserves a browser's native structured clone", async () => {
  execFileSync(process.execPath, ["scripts/build-document-runtime.mjs"], { stdio: "pipe" });
  const code = await fs.readFile("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/build/generated/document-runtime/assets/syncpeer-documents.js", "utf8");
  const nativeStructuredClone = globalThis.structuredClone;
  const nativeURL = globalThis.URL;
  const events = [];
  // Chromium WebView has native URL but no SharedArrayBuffer without cross-origin isolation.
  const context = vm.createContext({
    structuredClone: nativeStructuredClone, URL: nativeURL, URLSearchParams,
    SharedArrayBuffer: undefined,
    window: { addEventListener: event => events.push(event) },
  });
  assert.equal(await vm.runInContext(code, context), "ready");
  assert.equal(context.structuredClone, nativeStructuredClone);
  assert.equal(context.URL, nativeURL);
  assert.equal(vm.runInContext("typeof SharedArrayBuffer", context), "undefined");
  assert.deepEqual(events, ["message"]);
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
      globalThis.setTimeout(() => this.onmessage({ data: JSON.stringify({ id: request.__portId, result: null }) }), request.delayMs);
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

test("concurrent Android session bootstrap shares a single lifecycle owner", async () => {
  execFileSync(process.execPath, ["scripts/build-document-runtime.mjs"], { stdio: "pipe" });
  const code = await fs.readFile("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/build/generated/document-runtime/assets/syncpeer-documents.js", "utf8");
  const context = vm.createContext({});
  assert.equal(await vm.runInContext(code, context), "ready");
  let ports = 0, subscriptions = 0;
  const android = { getNamedPort: async name => {
    assert.equal(name, "network");
    ports++;
    return { onmessage: null, postMessage(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: request.__portId, result: null }) }));
    } };
  } };
  const documents = { onSessionConfigurationChange() { subscriptions++; } };
  const start = () => context.syncpeerDocumentsCore.startSession(android, documents);
  const sessions = await Promise.all(Array.from({ length: 8 }, start));
  assert.equal(ports, 1);
  assert.equal(subscriptions, 1);
  for (const session of sessions) assert.equal(session, sessions[0]);
  assert.equal(await start(), sessions[0]);
});

// Kotlin's inline JavaScript does not pass through the Chrome 69 transpilation
// applied to syncpeer-documents.js. Reject unsupported syntax before Android CI.
test("Kotlin-hosted document runtime code parses on legacy Android WebView", async () => {
  const source = await fs.readFile(
    "packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/DocumentRuntimeService.kt", "utf8");
  const command = source.match(/fun command\(input: JSONObject\): CompletableFuture<JSONObject> \{[\s\S]*?return evaluateRuntime\("""([\s\S]*?)"""\.trimIndent\(\), input\.toString\(\)/)?.[1];
  const shutdown = source.match(/runtimeHost\?\.evaluate\("([^"]+)", ByteArray\(0\)\)/)?.[1];
  assert.ok(command, "Android document command JavaScript must be found");
  assert.ok(shutdown, "Android runtime shutdown JavaScript must be found");
  for (const script of [command, shutdown]) {
    assert.doesNotThrow(() => parse(`async function evaluate(android, input) {\n${script}\n}`, { ecmaVersion: 2018 }));
  }
});
