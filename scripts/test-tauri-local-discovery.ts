import { spawn } from "node:child_process";

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
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

async function run(): Promise<void> {
  await runCommand("npm", [
    "run",
    "icons:ensure",
    "-w",
    "@syncpeer/tauri-shell",
  ]);
  await runCommand("cargo", [
    "test",
    "syncpeer_packet_",
    "--manifest-path",
    "packages/tauri-shell/src-tauri/Cargo.toml",
  ]);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
