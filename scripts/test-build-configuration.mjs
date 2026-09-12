import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("application builds compile the core workspace first", () => {
  const scripts = json("package.json").scripts;
  assert.equal(
    scripts["build:app"],
    "npm run build:core && npm run build -w @syncpeer/app",
  );
});

test("Tauri builds use the dependency-aware application build", () => {
  const configs = [
    [
      "packages/tauri-shell/src-tauri/tauri.conf.json",
      "npm --prefix ../.. run build:app",
    ],
    [
      "packages/tauri-shell/src-tauri/tauri.lan-e2e.conf.json",
      "npm --prefix ../.. run build:app -- -- --mode lan-e2e",
    ],
    [
      "packages/tauri-shell/src-tauri/tauri.android-e2e.conf.json",
      "npm --prefix ../.. run build:app -- -- --mode android-e2e",
    ],
  ];

  for (const [file, expected] of configs) {
    assert.equal(json(file).build.beforeBuildCommand, expected);
  }
});

test("Android release setup uses tools available on standard runners", () => {
  const script = fs.readFileSync("scripts/build-android-prod-with-secrets.sh", "utf8");
  assert.doesNotMatch(script, /\brg\b/);
});
