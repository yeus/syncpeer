import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface TestSuitePhase {
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  skipReason?: () => string | undefined;
  required?: boolean;
}

export const nodeScript = (script: string, args: string[] = []): TestSuitePhase => ({
  name: script,
  command: process.execPath,
  args: ["--experimental-strip-types", script, ...args],
});

export const tsxScript = (script: string, args: string[] = []): TestSuitePhase => ({
  name: script,
  command: process.execPath,
  args: [path.resolve("node_modules/tsx/dist/cli.mjs"), script, ...args],
});

type PhaseResult = {
  name: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  reason?: string;
};

export const testEnvironment = (): NodeJS.ProcessEnv => {
  const configuredHome = process.env.SYNCPEER_DEV_CLIENT_CONFIG_HOME?.trim();
  return {
    ...process.env,
    ...(configuredHome
      ? { XDG_CONFIG_HOME: path.resolve(configuredHome) }
      : {}),
  };
};

const runPhase = (phase: TestSuitePhase, env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(phase.command, phase.args, {
      cwd: process.cwd(),
      env: { ...env, ...phase.env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

export const runTestSuite = async (args: {
  name: string;
  reportPath: string;
  phases: TestSuitePhase[];
}): Promise<number> => {
  const env = testEnvironment();
  const startedAtMs = Date.now();
  const results: PhaseResult[] = [];

  for (const phase of args.phases) {
    const reason = phase.skipReason?.();
    if (reason) {
      if (phase.required) {
        console.error(`\n=== ${phase.name}: failed (${reason}) ===`);
        results.push({ name: phase.name, status: "failed", reason, exitCode: 1 });
        continue;
      }
      console.log(`\n=== ${phase.name}: skipped (${reason}) ===`);
      results.push({ name: phase.name, status: "skipped", reason });
      continue;
    }
    console.log(`\n=== ${phase.name} ===`);
    try {
      const exitCode = await runPhase(phase, env);
      const status = exitCode === 0 ? "passed" : "failed";
      console.log(`=== ${phase.name}: ${status} ===`);
      results.push({ name: phase.name, status, exitCode });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`=== ${phase.name}: failed (${message}) ===`);
      results.push({ name: phase.name, status: "failed", exitCode: 1, reason: message });
    }
  }

  const report = {
    report_date: new Date().toISOString(),
    suite: args.name,
    duration_ms: Date.now() - startedAtMs,
    phases: results,
    summary: {
      all_passed: results.every((phase) => phase.status !== "failed"),
      passed: results.filter((phase) => phase.status === "passed").length,
      failed: results.filter((phase) => phase.status === "failed").length,
      skipped: results.filter((phase) => phase.status === "skipped").length,
    },
  };
  fs.mkdirSync(path.dirname(path.resolve(args.reportPath)), { recursive: true });
  fs.writeFileSync(
    path.resolve(args.reportPath),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
  console.log(`\n${JSON.stringify(report, null, 2)}`);
  return report.summary.all_passed ? 0 : 1;
};
