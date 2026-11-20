import assert from "node:assert/strict";
import test from "node:test";
import { createEncryptedUiStateStore } from "../packages/app/src/app/encryptedUiState.ts";
import { loadVerifiedFolderPasswords } from "../packages/app/src/app/credentialLoading.ts";
import {
  applySensitiveAppState,
  createInitialState,
  sensitiveAppState,
  type SensitiveAppState,
} from "../packages/app/src/app/state.ts";

const PEER_ID = "DPNAVCUNBE5A5HUY4AN5YALD4RILEIXAJCYRGJBAGNLHYXFBWDKA";
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

const stateWithPeer = () => {
  const state = createInitialState(null);
  state.devices.savedDevices = [{
    id: PEER_ID,
    name: "Saved peer",
    createdAtMs: 1,
    isIntroducer: false,
    customName: true,
  }];
  state.devices.selectedSavedDeviceId = PEER_ID;
  return state;
};

const storedPayload = (): SensitiveAppState =>
  JSON.parse(JSON.stringify(sensitiveAppState(stateWithPeer()))) as SensitiveAppState;

test("saved peers survive an encrypted UI-state round trip", () => {
  const restarted = createInitialState(null);
  assert.equal(applySensitiveAppState(restarted, storedPayload()), true);
  assert.deepEqual(restarted.devices.savedDevices.map((device) => device.id), [PEER_ID]);
  assert.equal(restarted.devices.selectedSavedDeviceId, PEER_ID);
});
test("startup reuses verified encrypted passwords without extra merge and reread", async () => {
  const calls: string[] = [];
  const saved = { "folder-1": "test-secret" };
  const resolved = await loadVerifiedFolderPasswords({
    load: async () => { calls.push("load"); return saved; },
    merge: async () => { calls.push("merge"); },
  }, { "folder-1": "test-secret" });
  assert.deepEqual(resolved, saved);
  assert.deepEqual(calls, ["load"]);
});

test("startup migration merges missing credentials and verifies persisted values", async () => {
  const calls: string[] = [];
  let saved = { "folder-1": "existing" };
  const credentials = {
    load: async () => { calls.push("load"); return { ...saved }; },
    merge: async (pending: Record<string, string>) => {
      calls.push("merge"); saved = { ...saved, ...pending };
    },
  };
  const resolved = await loadVerifiedFolderPasswords(credentials, {
    "folder-1": "existing", "folder-2": "migrated",
  });
  assert.deepEqual(calls, ["load", "merge", "load"]);
  assert.deepEqual(resolved, { "folder-1": "existing", "folder-2": "migrated" });
});

test("startup rejects credential conflicts and unverified migrations", async () => {
  await assert.rejects(loadVerifiedFolderPasswords({
    load: async () => ({ "folder-1": "correct" }),
    merge: async () => { throw new Error("must not merge conflicting secrets"); },
  }, { "folder-1": "wrong" }), /Conflicting saved folder passwords/);
  await assert.rejects(loadVerifiedFolderPasswords({
    load: async () => ({}),
    merge: async () => undefined,
  }, { "folder-1": "migrated" }), /could not be verified/);
});


test("a failed save does not stop later encrypted UI-state saves", async () => {
  const operations: string[] = [];
  const failures: string[] = [];
  let failNextSave = true;
  const store = createEncryptedUiStateStore({
    command: async <T>(request: Record<string, unknown>): Promise<T> => {
      operations.push(String(request.operation));
      if (request.operation === "saveUiState" && failNextSave) {
        failNextSave = false;
        throw new Error("synthetic document runtime failure");
      }
      return null as T;
    },
    readLegacy: () => null,
    apply: () => false,
    onFailure: (event) => { failures.push(event); },
    saveDelayMs: 0,
  });
  await store.load();
  store.scheduleSave(storedPayload());
  await settle();
  assert.deepEqual(failures, ["app.ui_state.save_failed"], "A save failure must be reported.");
  assert.equal(store.isLoaded(), true,
    "A transient save failure must not mark the encrypted state as unloaded.");
  store.scheduleSave(storedPayload());
  await settle();
  assert.equal(operations.filter((operation) => operation === "saveUiState").length, 2,
    "The next change must be saved again after a failed save.");
});

test("vault startup failure must never overwrite an existing peer roster with empty UI state", async () => {
  const operations: string[] = [];
  const store = createEncryptedUiStateStore({
    command: async <T>(request: Record<string, unknown>): Promise<T> => {
      operations.push(String(request.operation));
      if (request.operation === "uiState")
        throw new Error("Document operation failed. Check the vault and Android System WebView.");
      throw new Error("A save would overwrite existing data.");
    },
    readLegacy: () => null, apply: () => false, onFailure: () => undefined,
    saveDelayMs: 0,
  });
  await assert.rejects(store.load(), /Document operation failed/);
  assert.equal(store.isLoaded(), false);
  store.scheduleSave(sensitiveAppState(createInitialState(null)));
  await settle();
  assert.deepEqual(operations, ["uiState"]);
});

test("encrypted UI-state load rejects an invalid stored document", async () => {
  const store = createEncryptedUiStateStore({
    command: async <T>(): Promise<T> => ({ approvals: "not-an-array" }) as T,
    readLegacy: () => null,
    apply: () => false,
    onFailure: () => undefined,
    saveDelayMs: 0,
  });
  await assert.rejects(store.load(), /Invalid encrypted UI state/);
  assert.equal(store.isLoaded(), false);
});

test("legacy plaintext UI state migrates and is verified before use", async () => {
  const legacy = storedPayload();
  let stored: unknown = null;
  const store = createEncryptedUiStateStore({
    command: async <T>(request: Record<string, unknown>): Promise<T> => {
      if (request.operation === "saveUiState") {
        stored = request.state;
        return null as T;
      }
      return stored as T;
    },
    readLegacy: () => legacy,
    apply: () => true,
    onFailure: () => undefined,
    saveDelayMs: 0,
  });
  assert.equal(await store.load(), true);
  assert.deepEqual(stored, JSON.parse(JSON.stringify(legacy)));
  assert.equal(store.isLoaded(), true);
});

test("unchanged sensitive state is not written again on session notifications", async () => {
  const writes: string[] = [];
  const store = createEncryptedUiStateStore({
    command: async <T>(request: Record<string, unknown>) => {
      if (request.operation === "saveUiState") writes.push(JSON.stringify(request.state));
      return null as T;
    },
    readLegacy: () => null, apply: () => false, onFailure: () => undefined, saveDelayMs: 0,
  });
  await store.load();
  const payload = storedPayload();
  for (let index = 0; index < 20; index += 1) store.scheduleSave(storedPayload());
  await settle();
  assert.equal(writes.length, 1);
  store.scheduleSave(payload);
  await settle();
  assert.equal(writes.length, 1);
});

test("newer sensitive state is saved after an in-flight write, without concurrent writes", async () => {
  let finishFirst!: () => void;
  let saves = 0;
  let active = 0;
  let maxActive = 0;
  const written: string[] = [];
  const store = createEncryptedUiStateStore({
    command: async <T>(request: Record<string, unknown>) => {
      if (request.operation === "saveUiState") {
        saves++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (saves === 1) await new Promise<void>(resolve => { finishFirst = resolve; });
        written.push(JSON.stringify(request.state));
        active--;
      }
      return null as T;
    },
    readLegacy: () => null, apply: () => false, onFailure: () => undefined, saveDelayMs: 0,
  });
  await store.load();
  const initial = storedPayload();
  const latest = { ...storedPayload(), selectedSavedDeviceId: "" };
  store.scheduleSave(initial);
  await settle();
  store.scheduleSave(latest);
  store.scheduleSave(latest);
  await settle();
  assert.equal(maxActive, 1);
  finishFirst();
  await settle();
  assert.equal(saves, 2);
  assert.equal(maxActive, 1);
  assert.equal(written.at(-1), JSON.stringify(latest));
});
