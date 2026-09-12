import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const usage = "Usage: npm run ci:logs -- [run-id]";

export const latestFailedRunArgs = () => [
  "run", "list",
  "--status", "failure",
  "--limit", "1",
  "--json", "databaseId",
  "--jq", ".[0].databaseId",
];

export const failedRunLogArgs = (runId) => [
  "run", "view", runId, "--log-failed",
];

const numericRunId = (value) => {
  const runId = value.trim();
  if (!/^\d+$/.test(runId)) {
    throw new Error("Expected a numeric GitHub Actions run ID.");
  }
  return runId;
};

export const downloadCiLogs = ({ argv, root, runGh }) => {
  if (argv.length > 1) throw new Error(usage);
  const runId = numericRunId(argv[0] ?? runGh(latestFailedRunArgs()));
  const logs = runGh(failedRunLogArgs(runId));
  if (!logs.trim()) throw new Error(`Run ${runId} has no failed-step log output.`);

  const destination = path.join(root, ".ci-logs", `run-${runId}-failed.log`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, logs, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(destination, 0o600);
  return destination;
};

const runGh = (args) => {
  const result = spawnSync("gh", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "GitHub CLI request failed.");
  }
  return result.stdout;
};

const run = () => {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(usage);
    return;
  }
  const destination = downloadCiLogs({ argv, root: process.cwd(), runGh });
  console.log(`CI logs: ${pathToFileURL(destination).href}`);
};

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
