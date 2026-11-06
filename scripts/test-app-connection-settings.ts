import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer } from "vite";
import type * as AppActions from "../packages/app/src/app/actions.ts";
import type * as AppState from "../packages/app/src/app/state.ts";
import type * as DevicePolicies from "../packages/app/src/app/devicePolicies.ts";
import type { TransferRuntime } from "../packages/app/src/app/transferRuntime.ts";

const verifySettingsReplacement = async (t: TestContext, rejectOnDisconnect: boolean, changed = true) => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { createAppActions } = await server.ssrLoadModule("/packages/app/src/app/actions.ts") as typeof AppActions;
  const { createTransferRuntime } = await server.ssrLoadModule("/packages/app/src/app/transferRuntime.ts") as {
    createTransferRuntime: (args: {
      state: Parameters<typeof createAppActions>[0]["state"];
      client: Parameters<typeof createAppActions>[0]["client"];
      runtimeSurface: "web-ui";
    }) => TransferRuntime;
  };
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const state = createInitialState(null);
  state.connection.deviceName = "fixture-client";
  state.connection.discoveryMode = "direct";
  state.connection.remoteId = "A".repeat(52);
  state.devices.savedDevices = [{ id: state.connection.remoteId, name: "Synthetic peer", isIntroducer: false, createdAtMs: Date.now() }];
  state.connection.cert = "synthetic-certificate";
  state.connection.key = "synthetic-private-key";
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  const events: string[] = [];
  let rejectOpening: ((error: Error) => void) | undefined;
  const actions = createAppActions({
    state,
    client: {} as Parameters<typeof createAppActions>[0]["client"],
    sessionStore: { actions: {
      setFolderPasswords: async () => {},
      connect: async () => {
        events.push("connect");
        if (events.filter(event => event === "connect").length > 1) throw new Error("fixture stop");
        await new Promise<void>((_resolve, reject) => { rejectOpening = reject; });
      },
      disconnect: async () => {
        events.push("disconnect");
        if (rejectOnDisconnect) rejectOpening?.(new Error("fixture cancellation"));
      },
    } } as unknown as Parameters<typeof createAppActions>[0]["sessionStore"],
    transfers: createTransferRuntime({
      state,
      client: {} as Parameters<typeof createAppActions>[0]["client"],
      runtimeSurface: "web-ui",
    }),
  });
  const opening = actions.connect();
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(events, ["connect"]);
    if (changed) state.connection.port += 1;
    actions.scheduleConnectionSettingsApply();
    await new Promise(resolve => setTimeout(resolve, 650));
    if (changed) assert.deepEqual(events.slice(0, 3), ["connect", "disconnect", "connect"]);
    else assert.deepEqual(events, ["connect"]);
    assert.equal(JSON.stringify(errors).includes("synthetic-private-key"), false,
      "Connection diagnostics must not copy the private key from connection settings");
  } finally {
    rejectOpening?.(new Error("fixture cleanup"));
    await opening;
    await actions.disconnect();
  }
};

test("changing settings cancels an unfinished connection before waiting for it", async t => {
  await verifySettingsReplacement(t, true);
});

test("changing settings can supersede a native connection that never settles after cancellation", async t => {
  await verifySettingsReplacement(t, false);
});

test("identical settings do not cancel a pending peer connection", async t => {
  await verifySettingsReplacement(t, false, false);
});

test("a saved peer retains its explicitly configured direct endpoint but a different peer uses discovery", async t => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { preferredConnectionForDevice } = await server.ssrLoadModule(
    "/packages/app/src/app/devicePolicies.ts",
  ) as typeof DevicePolicies;
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const connection = createInitialState(null).connection;
  const selectedId = "A".repeat(52);
  connection.remoteId = selectedId;
  connection.discoveryMode = "direct";
  connection.host = "127.0.0.1";
  connection.port = 22000;

  assert.deepEqual(preferredConnectionForDevice(connection, selectedId), {
    remoteId: selectedId, discoveryMode: "direct", host: "127.0.0.1",
  });
  assert.deepEqual(preferredConnectionForDevice(connection, "B".repeat(52)), {
    remoteId: "B".repeat(52), discoveryMode: "automatic", host: "",
  });
});
