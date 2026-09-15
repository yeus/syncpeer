import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = (executable, args, options = {}) => execFileSync(executable, args, {
  encoding: "utf8",
  stdio: "inherit",
  ...options,
});

const avdExists = (avdName) => {
  try {
    const output = execFileSync("avdmanager", ["list", "avd", "-c"], {
      encoding: "utf8",
    });
    return output.split(/\r?\n/).includes(avdName);
  } catch {
    return false;
  }
};

export const create = ({ avdName, systemImage }) => {
  if (avdExists(avdName)) return;
  run("avdmanager", [
    "create", "avd",
    "--name", avdName,
    "--package", systemImage,
    "--device", "pixel_2",
  ], { input: "no\n", stdio: ["pipe", "inherit", "inherit"] });
};

export const profile = (name) => {
  if (name === "compat") return {
    avdName: "syncpeer-api29",
    systemImage: "system-images;android-29;google_apis_playstore;x86_64",
  };
  if (name === "modern") return {
    avdName: "syncpeer-api36-play",
    systemImage: "system-images;android-36;google_apis_playstore;x86_64",
  };
  throw new Error(`Unknown Android emulator profile: ${name}`);
};

export const emulatorArguments = (selected, extraArguments = []) => [
  "-avd", selected.avdName,
  "-gpu", "swiftshader_indirect",
  "-no-audio",
  "-no-metrics",
  "-no-snapshot-save",
  ...extraArguments,
];

export const start = (selected, extraArguments = []) => {
  run("emulator", emulatorArguments(selected, extraArguments));
};

const main = (args) => {
  const command = args[0] || "start";
  const selected = profile(args[1] || "compat");
  const emulatorArguments = args.slice(2).filter((argument) => argument !== "--");
  if (command === "create") {
    create(selected);
    return;
  }
  if (command !== "start") {
    throw new Error("Usage: android-emulator.mjs <create|start> [compat|modern]");
  }
  create(selected);
  start(selected, emulatorArguments);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
