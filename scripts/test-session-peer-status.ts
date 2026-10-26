import assert from "node:assert/strict";
import test from "node:test";
import { createSyncpeerSessionStore, type ServiceSessionStatusEvent,
  type ConnectionLifecycleState } from "../packages/core/src/browser.ts";

const createStore = () => {
  let lifecycleListener: ((state: ConnectionLifecycleState) => void) | null = null;
  let peerListener: ((event: ServiceSessionStatusEvent) => void) | null = null;
  const store = createSyncpeerSessionStore({
    transport: {
      connectAndSync: async () => { throw new Error("not used"); },
      connectAndGetOverview: async () => { throw new Error("not used"); },
      connectAndGetFolderVersions: async () => [],
      subscribeLifecycle: listener => {
        lifecycleListener = listener;
        return () => { lifecycleListener = null; };
      },
      subscribePeerStatus: listener => {
        peerListener = listener;
        return () => { peerListener = null; };
      },
    },
  });
  const lifecycle = (phase: ConnectionLifecycleState["phase"]) =>
    lifecycleListener?.({ phase, attempt: 0, nextRetryAtMs: null, closureReason: null,
      upgradeStatus: "idle" });
  const peer = (event: ServiceSessionStatusEvent) => peerListener?.(event);
  return { store, lifecycle, peer };
};

test("session store renders pushed Android peer phases and ignores stale revisions", () => {
  const { store, lifecycle, peer } = createStore();
  assert.equal(store.getState().peerStatus, null);
  lifecycle("connected");
  peer({ type: "sessionStatus", revision: 4, phase: "connected", active: true,
    foreground: true, peerPhase: "connected" });
  assert.equal(store.getState().peerStatus?.phase, "connected");
  peer({ type: "sessionStatus", revision: 3, phase: "waiting", active: true,
    foreground: true, peerPhase: "waiting", error: "stale" });
  assert.equal(store.getState().peerStatus?.phase, "connected", "Stale revisions must be ignored.");
  peer({ type: "sessionStatus", revision: 5, phase: "connected", active: true,
    foreground: true, peerPhase: "reconnecting", peerError: "Peer is reconnecting." });
  assert.equal(store.getState().peerStatus?.phase, "reconnecting");
  assert.equal(store.getState().peerStatus?.error, "Peer is reconnecting.");
  assert.notEqual(store.getState().phase, "reconnecting",
    "Pushed peer status must not replace the usable outer lifecycle phase.");
  lifecycle("idle");
  assert.equal(store.getState().peerStatus, null);
});
