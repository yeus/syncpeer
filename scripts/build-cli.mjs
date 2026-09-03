import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = path.join(repositoryRoot, "packages", "cli");
const distRoot = path.join(cliRoot, "dist");

const gitCommit = () => {
  const configured = [
    process.env.SYNCPEER_BUILD_COMMIT,
    process.env.GIT_COMMIT,
    process.env.CI_COMMIT_SHA,
    process.env.CI_COMMIT_SHORT_SHA,
  ].find((value) => value?.trim());
  if (configured) return configured.trim();
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
};

const buildTimeUtc = () => {
  const configured = process.env.SYNCPEER_BUILD_TIME_UTC?.trim();
  if (configured && !Number.isNaN(Date.parse(configured))) return configured;
  return new Date().toISOString();
};

const compile = spawnSync("tsc", ["-p", "tsconfig.json"], {
  cwd: cliRoot,
  stdio: "inherit",
});
if (compile.status !== 0) process.exit(compile.status ?? 1);

fs.writeFileSync(
  path.join(distRoot, "build-info.json"),
  JSON.stringify({ buildCommit: gitCommit(), buildTimeUtc: buildTimeUtc() }, null, 2) + "\n",
  "utf8",
);
