import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeArgs = ["--experimental-strip-types"];

const shouldSkip = (name: string): boolean =>
  process.argv.includes(`--skip-${name}`) || process.env[`SYNCPEER_DEV_SKIP_${name.toUpperCase()}`] === "1";

const testEnvironment = (): NodeJS.ProcessEnv => {
  const configuredHome = process.env.SYNCPEER_DEV_CLIENT_CONFIG_HOME?.trim();
  return {
    ...process.env,
    ...(configuredHome
      ? { XDG_CONFIG_HOME: path.resolve(configuredHome) }
      : {}),
  };
};

const runPhase = (name: string, command: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<number>((resolve, reject) => {
    console.log(`\n=== ${name} ===`);
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const result = code ?? (signal ? 1 : 0);
      console.log(`=== ${name}: ${result === 0 ? "passed" : "failed"} ===`);
      resolve(result);
    });
  });

const run = async (): Promise<void> => {
  const env = testEnvironment();
  const phases: Array<{ name: string; command: string; args: string[] }> = [];
  if (!shouldSkip("local")) {
    phases.push({ name: "Local CLI and Syncthing regression suite", command: npmCommand, args: ["run", "test:local"] });
  }
  if (!shouldSkip("cli")) {
    phases.push({
      name: "Remote CLI diagnostics",
      command: process.execPath,
      args: [...nodeArgs, "scripts/test-dev-cli.ts"],
    });
  }
  if (!shouldSkip("ui")) {
    phases.push({
      name: "Tauri UI diagnostics",
      command: process.execPath,
      args: [...nodeArgs, "scripts/test-dev.ts", "--client", "--ui-smoke"],
    });
  }
  if (phases.length === 0) throw new Error("All development test phases were skipped.");

  const startedAtMs = Date.now();
  const phaseResults: Array<{ name: string; exitCode: number }> = [];
  for (const phase of phases) {
    const exitCode = await runPhase(phase.name, phase.command, phase.args, env);
    phaseResults.push({ name: phase.name, exitCode });
  }

  const report = {
    report_date: new Date().toISOString(),
    duration_ms: Date.now() - startedAtMs,
    phases: phaseResults,
    summary: {
      all_passed: phaseResults.every((phase) => phase.exitCode === 0),
      passed: phaseResults.filter((phase) => phase.exitCode === 0).length,
      failed: phaseResults.filter((phase) => phase.exitCode !== 0).length,
    },
  };
  const reportDir = path.resolve(
    process.env.SYNCPEER_LAN_CLIENT_ROOT ?? ".tmp/syncpeer-dev-client",
    "diagnostics",
  );
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, "development-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
  console.log(`\n${JSON.stringify(report, null, 2)}`);
  if (!report.summary.all_passed) process.exitCode = 1;
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
