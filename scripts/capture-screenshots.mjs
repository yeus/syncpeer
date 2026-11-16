import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotsDir = path.join(repositoryRoot, ".screenshots");
const tauriRoot = path.join(repositoryRoot, "packages/tauri-shell");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed.`);
};

await rm(screenshotsDir, { recursive: true, force: true });
await mkdir(screenshotsDir, { recursive: true });

run("npm", ["run", "icons:ensure", "-w", "@syncpeer/tauri-shell"]);

run("npx", [
  "tauri", "build",
  "--bundles", "deb",
  "--config", "src-tauri/tauri.lan-e2e.conf.json",
], { cwd: tauriRoot });

const tauriConfig = JSON.parse(await readFile(
  path.join(tauriRoot, "src-tauri/tauri.conf.json"),
  "utf8",
));
// Tauri honors CARGO_TARGET_DIR; use the artifact from this build rather
// than accidentally testing a stale .deb in src-tauri/target.
const cargoTarget = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(tauriRoot, "src-tauri/target");
const debDir = path.join(cargoTarget, "release/bundle/deb");
const candidates = (await readdir(debDir))
  .filter(name => name.startsWith(`Syncpeer_${tauriConfig.version}_`) && name.endsWith(".deb"));
assert.equal(candidates.length, 1,
  `Expected one .deb for Syncpeer ${tauriConfig.version}, found: ${candidates.join(", ") || "none"}.`);
const artifact = path.join(debDir, candidates[0]);

run("npm", ["run", "test:tauri:deb", "--", artifact], {
  env: { SYNCPEER_SCREENSHOT_DIR: screenshotsDir },
});

const expected = [
  "syncpeer-personal-space.png",
  "syncpeer-encrypted-folder.png",
  "syncpeer-sync.png",
];
for (const name of expected) {
  const info = await stat(path.join(screenshotsDir, name));
  assert.ok(info.isFile() && info.size > 0, `Screenshot is missing or empty: ${name}`);
}
console.log(`Captured ${expected.length} screenshots in ${screenshotsDir}.`);
