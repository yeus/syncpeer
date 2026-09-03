import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["packages/cli/dist/main.js", "about"],
  { encoding: "utf8" },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
assert.equal(result.status, 0, output);
assert.match(output, /app_name: Syncpeer/);
assert.match(output, /app_version: \S+/);
assert.match(output, /build_commit: (?:[0-9a-f]{8,}|unknown)/i);
assert.match(output, /build_time_utc: \S+/);
assert.match(output, /runtime_surface: cli/);
assert.match(output, /runtime_environment: node/);
assert.doesNotMatch(output, /device|folder|127\.0\.0\.1/i);

const version = spawnSync(
  process.execPath,
  ["packages/cli/dist/main.js", "--version"],
  { encoding: "utf8" },
);
assert.equal(version.status, 0, `${version.stdout ?? ""}${version.stderr ?? ""}`);
assert.match(`${version.stdout ?? ""}`, /^\d+\.\d+\.\d+/);

console.log("CLI build information diagnostics passed.");
