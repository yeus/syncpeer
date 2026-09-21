import assert from "node:assert/strict";
import test from "node:test";
import { requestLocalDataReset } from "../packages/app/src/app/localReset.ts";

test("does not reset without the exact confirmation", async () => {
  let invoked = false;
  const result = await requestLocalDataReset({
    invoke: async () => { invoked = true; },
    prompt: () => "reset",
    clearLocalState: () => {},
    reload: () => {},
  });
  assert.equal(result, "cancelled");
  assert.equal(invoked, false);
});

test("clears local browser state after native reset succeeds", async () => {
  const actions: string[] = [];
  const result = await requestLocalDataReset({
    invoke: async (command, args) => {
      assert.equal(command, "syncpeer_reset_local_data");
      assert.deepEqual(args, { confirmation: "RESET LOCAL DATA" });
      actions.push("native");
    },
    prompt: () => "RESET LOCAL DATA",
    clearLocalState: () => { actions.push("clear"); },
    reload: () => { actions.push("reload"); },
  });
  assert.equal(result, "reset");
  assert.deepEqual(actions, ["native", "clear", "reload"]);
});
