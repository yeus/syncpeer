import { spawn } from "node:child_process";

function run(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cargo",
      [
        "test",
        "syncpeer_packet_",
        "--manifest-path",
        "packages/tauri-shell/src-tauri/Cargo.toml",
      ],
      {
        cwd: process.cwd(),
        stdio: "inherit",
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`cargo test failed with exit code ${code ?? -1}`));
    });
  });
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
