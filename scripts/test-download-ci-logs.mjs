import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadCiLogs,
  failedRunLogArgs,
  latestFailedRunArgs,
} from "./download-ci-logs.mjs";

test("CI log download selects the newest failed run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-ci-logs-"));
  const calls = [];
  const destination = downloadCiLogs({
    argv: [],
    root,
    runGh: (args) => {
      calls.push(args);
      return args[1] === "list" ? "123456\n" : "failed step output\n";
    },
  });

  assert.deepEqual(calls, [latestFailedRunArgs(), failedRunLogArgs("123456")]);
  assert.equal(destination, path.join(root, ".ci-logs", "run-123456-failed.log"));
  assert.equal(fs.readFileSync(destination, "utf8"), "failed step output\n");
});

test("CI log download accepts an explicit numeric run ID", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-ci-logs-"));
  const calls = [];
  const destination = downloadCiLogs({
    argv: ["789"],
    root,
    runGh: (args) => {
      calls.push(args);
      return "explicit run failure\n";
    },
  });

  assert.deepEqual(calls, [failedRunLogArgs("789")]);
  assert.equal(fs.readFileSync(destination, "utf8"), "explicit run failure\n");
});

test("CI log download rejects unsupported arguments", () => {
  assert.throws(
    () => downloadCiLogs({ argv: ["not-an-id"], root: "/tmp", runGh: () => "" }),
    /numeric GitHub Actions run ID/,
  );
  assert.throws(
    () => downloadCiLogs({ argv: ["123", "456"], root: "/tmp", runGh: () => "" }),
    /Usage:/,
  );
});
