import assert from "node:assert/strict";
import test from "node:test";
import { createEncryptedUiStateStore } from "../packages/app/src/app/encryptedUiState.ts";
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
