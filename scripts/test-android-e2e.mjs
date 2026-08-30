import { execFileSync } from "node:child_process";
import fs from "node:fs";

const config = JSON.parse(
  fs.readFileSync("packages/tauri-shell/src-tauri/tauri.conf.json", "utf8"),
);
const packageName = process.env.SYNCPEER_ANDROID_PACKAGE?.trim() || config.identifier;

const runAdb = (args, timeout = 30_000) => {
  try {
    return execFileSync("adb", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`adb ${args.join(" ")} failed: ${message}`, { cause: error });
  }
};

const listDevices = () => runAdb(["devices"]).split("\n")
  .slice(1)
  .filter((line) => /^\S+\s+device(?:\s|$)/.test(line));

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const assertForeground = () => {
  const activities = runAdb(["shell", "dumpsys", "activity", "activities"]);
  const focusLine = activities.split("\n").find((line) =>
    /mResumedActivity|mCurrentFocus|mFocusedApp/.test(line),
  );
  if (!focusLine?.includes(packageName)) {
    throw new Error(`Android app is not foregrounded: ${focusLine ?? "no focus record"}`);
  }
};

const main = async () => {
  runAdb(["wait-for-device"], 60_000);

  const devices = listDevices();
  if (devices.length !== 1) {
    throw new Error(`Expected exactly one adb device, found ${devices.length}`);
  }

  const installedPath = runAdb(["shell", "pm", "path", packageName]).trim();
  if (!installedPath) {
    throw new Error(
      `Android package ${packageName} is not installed; build and install the debug APK first.`,
    );
  }

  runAdb(["shell", "am", "force-stop", packageName]);
  runAdb(["shell", "monkey", "-p", packageName, "1"]);
  await wait(1_000);
  assertForeground();

  runAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await wait(300);
  runAdb(["shell", "monkey", "-p", packageName, "1"]);
  await wait(1_000);
  assertForeground();

  console.log(`Android E2E smoke passed for ${packageName}.`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
