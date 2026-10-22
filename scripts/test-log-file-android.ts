import assert from "node:assert/strict";
import test from "node:test";

type Call = { command: string; args?: Record<string, unknown> };

/** The Android adapter talks to Tauri through the global invoke hook. */
const installFakeTauri = (respond: (call: Call) => unknown) => {
  const storage = new Map<string, string>();
  const calls: Call[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
    },
  });
  Object.defineProperty(globalThis, "__TAURI__", {
    configurable: true,
    value: {
      core: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          const call = { command, args };
          calls.push(call);
          return respond(call);
        },
      },
    },
  });
  return { calls, storage };
};

const { createTauriAdapters } = await import("../packages/app/src/lib/tauriAdapters.ts");

const androidLogFile = () => {
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  assert.ok(adapters.logFile, "Android must expose the log file handoff.");
  return adapters.logFile;
};

test("cancelling the save folder picker reports no saved file", async () => {
  const { calls, storage } = installFakeTauri(() => {
    throw new Error("SAF directory selection was cancelled.");
  });
  assert.equal(await androidLogFile().save("syncpeer-logs.txt", "body"), null);
  assert.deepEqual(
    calls.map(call => call.command).filter(command => command !== "syncpeer_log_ui_error"),
    ["syncpeer_android_pick_saf_directory"],
    "A cancelled picker must not attempt a write.",
  );
  assert.equal(storage.size, 0, "A cancelled picker must not remember a folder.");
});

test("saving remembers the picked folder and saves without picking again", async () => {
  const { calls, storage } = installFakeTauri(() => "content://tree/logs");
  const file = androidLogFile();
  assert.equal(await file.save("syncpeer-logs-1.txt", "first"), "syncpeer-logs-1.txt");
  assert.equal(await file.save("syncpeer-logs-2.txt", "second"), "syncpeer-logs-2.txt");
  const pickers = calls.filter(call => call.command === "syncpeer_android_pick_saf_directory");
  const writes = calls.filter(call => call.command === "syncpeer_android_save_text_file");
  assert.equal(pickers.length, 1, "The folder must be picked once and then remembered.");
  assert.equal(writes.length, 2);
  const request = writes[0]!.args?.request as Record<string, unknown>;
  assert.equal(request.treeUri, "content://tree/logs");
  assert.equal(request.fileName, "syncpeer-logs-1.txt");
  assert.equal(request.mimeType, "text/plain");
  assert.equal(request.text, "first");
  assert.equal(storage.size, 1);
});

test("a save failure forgets the remembered folder so the next attempt re-picks", async () => {
  let failWrite = true;
  const { calls } = installFakeTauri(({ command }) => {
    if (command === "syncpeer_android_pick_saf_directory") return "content://tree/logs";
    if (command === "syncpeer_android_save_text_file") {
      if (failWrite) throw new Error("Permission revoked.");
      return null;
    }
    return null;
  });
  const file = androidLogFile();
  await assert.rejects(async () => file.save("syncpeer-logs-1.txt", "first"), /Permission revoked/);
  failWrite = false;
  assert.equal(await file.save("syncpeer-logs-2.txt", "second"), "syncpeer-logs-2.txt");
  assert.equal(calls.filter(call => call.command === "syncpeer_android_pick_saf_directory").length, 2,
    "A revoked grant must trigger a new picker instead of failing forever.");
});

test("sharing writes a text file through the Android share command", async () => {
  const { calls } = installFakeTauri(() => null);
  await androidLogFile().share("syncpeer-logs-1.txt", "body");
  const share = calls.find(call => call.command === "syncpeer_android_share_text_file");
  assert.ok(share);
  const request = share.args?.request as Record<string, unknown>;
  assert.equal(request.fileName, "syncpeer-logs-1.txt");
  assert.equal(request.text, "body");
  assert.equal(request.mimeType, "text/plain");
  assert.equal(request.chooserTitle, "Share Syncpeer logs");
});
