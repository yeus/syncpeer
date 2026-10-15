import { spawn } from "node:child_process";
import fs from "node:fs";

function runCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} failed with exit code ${code ?? -1}`),
      );
    });
  });
}

/** Use the pinned repository Syncthing as an interoperability fixture when present. */
async function resolveSyncthingFixture(): Promise<string | undefined> {
  try {
    const module = await import("./lan-test/syncthing.ts");
    const candidate = module.binaryPath("syncthing");
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function run(): Promise<void> {
  await runCommand("npm", [
    "run",
    "icons:ensure",
    "-w",
    "@syncpeer/tauri-shell",
  ]);
  const syncthingFixture = await resolveSyncthingFixture();
  await runCommand(
    "cargo",
    [
      "test",
      "local_discovery",
      "--manifest-path",
      "packages/tauri-shell/src-tauri/Cargo.toml",
    ],
    syncthingFixture
      ? { ...process.env, SYNCPEER_SYNCTHING_BIN: syncthingFixture }
      : process.env,
  );
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
