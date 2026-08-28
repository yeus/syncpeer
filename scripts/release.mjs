import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfigPath = "packages/tauri-shell/src-tauri/tauri.conf.json";
const cargoManifestPaths = [
  "packages/tauri-shell/src-tauri/Cargo.toml",
  "packages/tauri-shell/src-tauri/plugins/syncpeer-android/Cargo.toml",
];
const cargoLockPath = "packages/tauri-shell/src-tauri/Cargo.lock";
const packagePaths = [
  "package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/app/package.json",
  "packages/tauri-shell/package.json",
];
const packageLockWorkspacePaths = [
  "packages/core",
  "packages/cli",
  "packages/app",
  "packages/tauri-shell",
];

const absolutePath = (relativePath) => path.join(repositoryRoot, relativePath);

const readJson = (relativePath) => JSON.parse(
  fs.readFileSync(absolutePath(relativePath), "utf8"),
);

const writeJson = (relativePath, value) => {
  fs.writeFileSync(
    absolutePath(relativePath),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
};

const readText = (relativePath) => fs.readFileSync(absolutePath(relativePath), "utf8");

const writeText = (relativePath, value) => {
  fs.writeFileSync(absolutePath(relativePath), value, "utf8");
};

const gitOutput = (args) => {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim();
};

const isValidVersion = (value) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);

const projectVersion = () => readJson(tauriConfigPath).version;

const collectConsistencyErrors = () => {
  const expected = projectVersion();
  const errors = [];
  const packageLock = readJson("package-lock.json");

  for (const relativePath of packagePaths) {
    const packageJson = readJson(relativePath);
    if (packageJson.version !== expected) {
      errors.push(`${relativePath} has version ${packageJson.version}, expected ${expected}`);
    }
  }

  const dependencyChecks = [
    ["packages/cli/package.json", "@syncpeer/core"],
    ["packages/app/package.json", "@syncpeer/core"],
    ["packages/tauri-shell/package.json", "@syncpeer/app"],
  ];
  for (const [relativePath, dependency] of dependencyChecks) {
    const packageJson = readJson(relativePath);
    if (packageJson.dependencies?.[dependency] !== expected) {
      errors.push(`${relativePath} does not depend on ${dependency}@${expected}`);
    }
  }

  if (packageLock.packages[""]?.version !== expected) {
    errors.push(`package-lock.json root version is not ${expected}`);
  }
  for (const relativePath of packageLockWorkspacePaths) {
    if (packageLock.packages[relativePath]?.version !== expected) {
      errors.push(`package-lock.json ${relativePath} version is not ${expected}`);
    }
  }
  if (packageLock.packages["packages/cli"]?.dependencies?.["@syncpeer/core"] !== expected) {
    errors.push("package-lock.json packages/cli has a stale @syncpeer/core dependency");
  }
  if (packageLock.packages["packages/app"]?.dependencies?.["@syncpeer/core"] !== expected) {
    errors.push("package-lock.json packages/app has a stale @syncpeer/core dependency");
  }
  if (packageLock.packages["packages/tauri-shell"]?.dependencies?.["@syncpeer/app"] !== expected) {
    errors.push("package-lock.json packages/tauri-shell has a stale @syncpeer/app dependency");
  }

  for (const relativePath of cargoManifestPaths) {
    const match = readText(relativePath).match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
    if (!match || match[1] !== expected) {
      errors.push(`${relativePath} has a stale package version`);
    }
  }

  const cargoLock = readText(cargoLockPath);
  for (const packageName of ["tauri-shell", "tauri-plugin-syncpeer-android"]) {
    const pattern = new RegExp(`\\[\\[package\\]\\][\\s\\S]*?^name = "${packageName}"\\s*$[\\s\\S]*?^version = "([^"]+)"`, "m");
    const match = cargoLock.match(pattern);
    if (!match || match[1] !== expected) {
      errors.push(`${cargoLockPath} has a stale ${packageName} version`);
    }
  }

  const androidProperties = readText("packages/tauri-shell/src-tauri/gen/android/app/tauri.properties");
  if (!new RegExp(`^tauri\\.android\\.versionName=${expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "m").test(androidProperties)) {
    errors.push("Android tauri.properties has a stale versionName");
  }
  return { expected, errors };
};

const assertConsistency = () => {
  const result = collectConsistencyErrors();
  if (result.errors.length > 0) {
    throw new Error("Release metadata is inconsistent:\n- " + result.errors.join("\n- "));
  }
  console.log(`Release metadata is consistent at version ${result.expected}.`);
  return result.expected;
};

const assertTrackedWorktreeClean = () => {
  const changes = gitOutput(["status", "--porcelain", "--untracked-files=no"]);
  if (changes) {
    throw new Error("Commit tracked changes before preparing a release:\n" + changes);
  }
};

const assertTagAvailable = (version) => {
  const tag = `v${version}`;
  if (gitOutput(["tag", "--list", tag]) === tag) {
    throw new Error(`Git tag ${tag} already exists.`);
  }
};

const updatePackageMetadata = (version) => {
  for (const relativePath of packagePaths) {
    const packageJson = readJson(relativePath);
    packageJson.version = version;
    if (relativePath === "packages/cli/package.json" || relativePath === "packages/app/package.json") {
      packageJson.dependencies["@syncpeer/core"] = version;
    }
    if (relativePath === "packages/tauri-shell/package.json") {
      packageJson.dependencies["@syncpeer/app"] = version;
    }
    writeJson(relativePath, packageJson);
  }

  const packageLock = readJson("package-lock.json");
  packageLock.packages[""].version = version;
  for (const relativePath of packageLockWorkspacePaths) {
    packageLock.packages[relativePath].version = version;
  }
  packageLock.packages["packages/cli"].dependencies["@syncpeer/core"] = version;
  packageLock.packages["packages/app"].dependencies["@syncpeer/core"] = version;
  packageLock.packages["packages/tauri-shell"].dependencies["@syncpeer/app"] = version;
  writeJson("package-lock.json", packageLock);
};

const updateCargoVersion = (relativePath, version) => {
  const source = readText(relativePath);
  const updated = source.replace(
    /^(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
    `$1${version}$2`,
  );
  if (updated === source) throw new Error(`Could not update ${relativePath}.`);
  writeText(relativePath, updated);
};

const updateReleaseMetadata = (version) => {
  updatePackageMetadata(version);
  const tauriConfig = readJson(tauriConfigPath);
  tauriConfig.version = version;
  writeJson(tauriConfigPath, tauriConfig);
  for (const relativePath of cargoManifestPaths) updateCargoVersion(relativePath, version);

  const cargoLock = readText(cargoLockPath).replace(
    /^(\[\[package\]\]\s*\nname = "(tauri-shell|tauri-plugin-syncpeer-android)"\s*\nversion = ")[^"]+(")/gm,
    `$1${version}$3`,
  );
  writeText(cargoLockPath, cargoLock);

  const androidPropertiesPath = "packages/tauri-shell/src-tauri/gen/android/app/tauri.properties";
  const androidProperties = readText(androidPropertiesPath).replace(
    /^tauri\.android\.versionName=.*$/m,
    `tauri.android.versionName=${version}`,
  );
  writeText(androidPropertiesPath, androidProperties);
};

const latestTag = () => gitOutput(["tag", "--list", "--sort=-creatordate"])
  .split("\n")
  .find((tag) => /^v?\d+(?:\.\d+){1,2}(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) || "none";

const promptForVersion = async () => {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const current = projectVersion();
    console.log(`Current application version: ${current}`);
    console.log(`Latest local version-like tag: ${latestTag()}`);
    return (await terminal.question("New version (for example 0.4.0-rc.1): ")).trim();
  } finally {
    terminal.close();
  }
};

const confirm = async (version) => {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(
      `Prepare release ${version} and tag it later as v${version}? [y/N] `,
    )).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    terminal.close();
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    assertConsistency();
    return;
  }
  assertTrackedWorktreeClean();
  const current = projectVersion();
  const version = args.find((arg) => !arg.startsWith("--")) || await promptForVersion();
  if (!isValidVersion(version)) {
    throw new Error(`Invalid version: ${version}. Use semantic versioning, such as 0.4.0-rc.1.`);
  }
  if (version === current) throw new Error(`Version ${version} is already current.`);
  assertTagAvailable(version);
  if (args.includes("--dry-run")) {
    console.log(`Would update release metadata from ${current} to ${version}.`);
    return;
  }
  if (!(await confirm(version))) {
    console.log("Release preparation cancelled.");
    return;
  }
  updateReleaseMetadata(version);
  assertConsistency();
  console.log("Release metadata updated. Review and commit the changes, then push the commit and tag:");
  console.log(`  git tag -a v${version} -m "Release v${version}"`);
  console.log(`  git push origin v${version}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
