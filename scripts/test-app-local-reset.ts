import assert from "node:assert/strict";
import test from "node:test";
import { requestLocalDataReset } from "../packages/app/src/app/localReset.ts";

test("does not reset without the exact confirmation", async () => {
  let invoked = false;
  const result = await requestLocalDataReset({
    invoke: async () => { invoked = true; },
    prompt: () => "reset",
    clearLocalState: () => {},
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
    prompt: (message) => {
      assert.match(message, /unsynced edits/);
      assert.match(message, /Packaged Linux builds restart automatically/);
      assert.match(message, /development builds and Android.*open.*again/);
      return "RESET LOCAL DATA";
    },
    clearLocalState: () => { actions.push("clear"); },
  });
  assert.equal(result, "reset");
  assert.deepEqual(actions, ["native", "clear"]);
});

test("cancelling the warning leaves native and browser data unchanged", async () => {
  const actions: string[] = [];
  const result = await requestLocalDataReset({
    invoke: async () => { actions.push("native"); },
    prompt: () => null,
    clearLocalState: () => { actions.push("clear"); },
  });
  assert.equal(result, "cancelled");
  assert.deepEqual(actions, []);
});

test("a failed native reset does not clear browser state", async () => {
  let cleared = false;
  await assert.rejects(requestLocalDataReset({
    invoke: async () => { throw new Error("Synthetic cleanup failure"); },
    prompt: () => "RESET LOCAL DATA",
    clearLocalState: () => { cleared = true; },
  }), /Synthetic cleanup failure/);
  assert.equal(cleared, false);
});
