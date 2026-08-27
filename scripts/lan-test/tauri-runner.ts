import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export const lanAppBinary = (): string =>
  path.resolve("packages", "tauri-shell", "src-tauri", "target", "debug", "tauri-shell");

export const buildLanApp = (): void => {
  execFileSync(npmCommand, ["run", "build:lan", "-w", "@syncpeer/tauri-shell"], {
    stdio: "inherit",
  });
};

const runChild = (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

export const runLanWdio = async (env: NodeJS.ProcessEnv): Promise<number> => {
  const wdioBin = path.resolve("node_modules", "@wdio", "cli", "bin", "wdio.js");
  const configPath = path.resolve("scripts", "lan-test", "wdio.conf.ts");
  const wdioArgs = ["--import", "tsx", wdioBin, "run", configPath];
  const runEnv = { ...process.env, ...env, SYNCPEER_LAN_APP_BINARY: lanAppBinary() };
  const useXvfb = process.platform === "linux" &&
    (runEnv.SYNCPEER_LAN_XVFB === "1" || !runEnv.DISPLAY);
  if (useXvfb) {
    try {
      execFileSync("which", ["xvfb-run"], { stdio: "ignore" });
    } catch {
      throw new Error("No DISPLAY is available and xvfb-run is missing. Enter the Nix flake shell first.");
    }
  }
  return runChild(
    useXvfb ? "xvfb-run" : process.execPath,
    useXvfb ? ["-a", process.execPath, ...wdioArgs] : wdioArgs,
    runEnv,
  );
};
