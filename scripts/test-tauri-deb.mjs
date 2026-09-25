import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithPrivateSecretService } from "./lan-test/private-secret-service.mjs";

if (process.platform !== "linux") throw new Error("The .deb smoke test requires Linux.");
const artifactArg = process.argv[2];
if (!artifactArg?.endsWith(".deb")) {
  throw new Error("Pass the exact .deb artifact path to test; no previous build is selected implicitly.");
}
const artifact = path.resolve(artifactArg);
assert.ok((await stat(artifact)).isFile(), "The .deb artifact must be a file.");
const root = await mkdtemp(path.join(tmpdir(), "syncpeer-deb-smoke-"));
try {
  const packageRoot = path.join(root, "package");
  const extracted = spawnSync("dpkg-deb", ["--extract", artifact, packageRoot], { stdio: "inherit" });
  if (extracted.error) throw extracted.error;
  assert.equal(extracted.status, 0, "The .deb payload could not be extracted.");
  const binary = path.join(packageRoot, "usr", "bin", "tauri-shell");
  assert.ok((await stat(binary)).isFile(), "The .deb payload has no Tauri executable.");
  const code = await runWithPrivateSecretService("xvfb-run", ["-a", process.execPath,
    "--import", "tsx", path.resolve("node_modules/@wdio/cli/bin/wdio.js"),
    "run", path.resolve("scripts/lan-test/wdio.conf.ts")], {
    SYNCPEER_LAN_SPEC: "scripts/lan-test/release-smoke.spec.ts",
    SYNCPEER_LAN_APP_BINARY: binary,
    SYNCPEER_LAN_DRIVER: "external",
    SYNCPEER_LAN_MOCHA_TIMEOUT: "300000",
    SYNCPEER_LAN_LOG_LEVEL: "error",
    XDG_DATA_DIRS: process.env.SYNCPEER_DEB_XDG_DATA_DIRS ?? "/usr/share",
  });
  assert.equal(code, 0, "The packaged fresh-profile smoke test failed.");
  const pairing = spawnSync("xvfb-run", ["-a", process.execPath, "--import", "tsx",
    path.resolve("node_modules/@wdio/cli/bin/wdio.js"), "run",
    path.resolve("scripts/lan-test/wdio-pairing.conf.ts")], {
    stdio: "inherit", env: { ...process.env, SYNCPEER_LAN_APP_BINARY: binary,
      XDG_DATA_DIRS: process.env.SYNCPEER_DEB_XDG_DATA_DIRS ?? "/usr/share" },
  });
  if (pairing.error) throw pairing.error;
  assert.equal(pairing.status, 0, "The two-instance packaged pairing test failed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
