import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import type * as AppActions from "../packages/app/src/app/actions.ts";
import type * as AppState from "../packages/app/src/app/state.ts";
import type { TransferRuntime } from "../packages/app/src/app/transferRuntime.ts";

test("changing settings cancels an unfinished connection before waiting for it", async (t) => {
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
        rejectOpening?.(new Error("fixture cancellation"));
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
    actions.scheduleConnectionSettingsApply();
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.deepEqual(events, ["connect", "disconnect", "connect"]);
    assert.equal(JSON.stringify(errors).includes("synthetic-private-key"), false,
      "Connection diagnostics must not copy the private key from connection settings");
  } finally {
    rejectOpening?.(new Error("fixture cleanup"));
    await opening;
    await actions.disconnect();
  }
});
