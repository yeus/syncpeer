import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runCli = (args: string[]): { status: number; output: string } => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-cli-info-"));
  const outputPath = path.join(directory, "output.txt");
  const outputFd = fs.openSync(outputPath, "w");
  try {
    const result = spawnSync(
      process.execPath,
      ["packages/cli/dist/main.js", ...args],
      { stdio: ["ignore", outputFd, outputFd] },
    );
    return {
      status: result.error || result.status === null ? 1 : result.status,
      output: fs.readFileSync(outputPath, "utf8"),
    };
  } finally {
    fs.closeSync(outputFd);
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const main = (): void => {
  const about = runCli(["about"]);
  assert.equal(about.status, 0, about.output);
  assert.match(about.output, /app_name: Syncpeer/);
  assert.match(about.output, /app_version: \S+/);
  assert.match(about.output, /build_commit: (?:[0-9a-f]{8,}|unknown)/i);
  assert.match(about.output, /build_time_utc: \S+/);
  assert.match(about.output, /runtime_surface: cli/);
  assert.match(about.output, /runtime_environment: node/);
  assert.doesNotMatch(about.output, /device|folder|127\.0\.0\.1/i);

  const version = runCli(["--version"]);
  assert.equal(version.status, 0, version.output);
  assert.match(version.output, /^\d+\.\d+\.\d+/);
};

main();

console.log("CLI build information diagnostics passed.");
