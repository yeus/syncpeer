import assert from "node:assert/strict";
import test from "node:test";
import { createLatestDistinctTask } from "../packages/app/src/app/latestDistinctTask.ts";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test("repeated lifecycle snapshots enqueue one folder registration", async () => {
  const runs: string[] = [];
  const completed: string[] = [];
  const schedule = createLatestDistinctTask({
    keyOf: (value: string) => value,
    run: async (value: string) => { runs.push(value); return value; },
    onSuccess: value => completed.push(value),
    onError: error => { throw error; },
  });
  for (let i = 0; i < 40; i++) schedule("same-folders");
  await tick();
  schedule("same-folders");
  await tick();
  assert.deepEqual(runs, ["same-folders"]);
  assert.deepEqual(completed, ["same-folders"]);
});

test("a burst during an in-flight registration retains only the latest request", async () => {
  let unblock!: () => void;
  const runs: string[] = [];
  const completed: string[] = [];
  const schedule = createLatestDistinctTask({
    keyOf: (value: string) => value,
    run: async (value: string) => {
      runs.push(value);
      if (value === "a") await new Promise<void>(resolve => { unblock = resolve; });
      return value;
    },
    onSuccess: value => completed.push(value),
    onError: error => { throw error; },
  });
  schedule("a");
  for (const value of ["b", "b", "c", "c"]) schedule(value);
  unblock();
  await tick();
  assert.deepEqual(runs, ["a", "c"]);
  assert.deepEqual(completed, ["c"], "Stale registration result must not overwrite the latest folders.");
});

test("a failed registration remains retryable and returning to the prior state is not ignored", async () => {
  let fail = true;
  let unblock!: () => void;
  const runs: string[] = [];
  const failures: string[] = [];
  const schedule = createLatestDistinctTask({
    keyOf: (value: string) => value,
    run: async (value: string) => {
      runs.push(value);
      if (fail) { fail = false; throw new Error("transient"); }
      if (value === "b") await new Promise<void>(resolve => { unblock = resolve; });
      return value;
    },
    onSuccess: () => undefined,
    onError: error => failures.push(String(error)),
  });
  schedule("a");
  await tick();
  schedule("a");
  await tick();
  schedule("b");
  schedule("a");
  unblock();
  await tick();
  assert.deepEqual(runs, ["a", "a", "b", "a"]);
  assert.equal(failures.length, 1);
});
