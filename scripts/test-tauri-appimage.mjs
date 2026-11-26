import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithPrivateSecretService } from "./lan-test/private-secret-service.mjs";

if (process.platform !== "linux") throw new Error("The AppImage smoke test requires Linux.");
const artifactArg = process.argv[2];
if (!artifactArg?.endsWith(".AppImage")) {
  throw new Error("Pass the exact AppImage artifact path; no previous build is selected implicitly.");
}
const artifact = path.resolve(artifactArg);
const artifactStat = await stat(artifact);
assert.ok(artifactStat.isFile(), "The AppImage must be a regular file.");
await access(artifact, constants.X_OK);

// Some container/NixOS hosts return ENOENT on execve for the static-PIE
// AppImage runtime despite the artifact being present and executable. Verify
// execution *before* launching WebDriver or its /session call can hang for
// minutes without ever creating an application process.
const payloadOnly = process.env.SYNCPEER_APPIMAGE_PAYLOAD_ONLY === "1";
if (!payloadOnly) {
  const runtime = spawnSync(artifact, ["--appimage-version"], {
    encoding: "utf8", timeout: 15_000,
  });
  if (runtime.status !== 0) {
    const reason = runtime.error?.code || String(runtime.status);
    throw new Error(`The Type2 AppImage runtime cannot execute on this host (${reason}). The packaged executable gate is NOT passed. Run on a compatible Linux host or set SYNCPEER_APPIMAGE_PAYLOAD_ONLY=1 to verify only the original embedded SquashFS payload.`);
  }
}

const root = await mkdtemp(path.join(tmpdir(), "syncpeer-appimage-smoke-"));
try {
  let target = artifact;
  if (payloadOnly) {
    const dest = path.join(root, "original-payload");
    const tool = process.env.SYNCPEER_TEST_UNSQUASHFS?.trim() || "unsquashfs";
    // A Type2 AppImage is an ELF runtime with an embedded SquashFS filesystem.
    // unsquashfs needs the payload offset; extracting the ELF as if it started
    // at byte 0 incorrectly reports "no valid superblock".
    const header = Buffer.alloc(Math.min(8 * 1024 * 1024, artifactStat.size));
    const file = await open(artifact, "r");
    try {
      await file.read(header, 0, header.length, 0);
    } finally {
      await file.close();
    }
    let offset = -1;
    for (let i = header.indexOf("hsqs");
      i >= 0 && i < header.length - 96;
      i = header.indexOf("hsqs", i + 4)) {
      if (header.readUInt16LE(i + 28) !== 4 ||
          header.readUInt16LE(i + 30) !== 0) continue;
      const bytesUsed = header.readBigUInt64LE(i + 40);
      if (bytesUsed < 4096n ||
          bytesUsed > BigInt(artifactStat.size - i)) continue;
      offset = i;
      break;
    }
    if (offset < 0) throw new Error("No valid embedded SquashFS 4:0 header in AppImage.");
    const extracted = spawnSync(tool, [
      "-offset", String(offset), "-f", "-no-progress", "-dest", dest, artifact,
    ], {
      encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (extracted.status !== 0) {
      throw new Error(`Original AppImage SquashFS extraction failed: ${extracted.error?.code || extracted.stderr?.slice(-400) || extracted.status}`);
    }
    target = path.join(dest, "AppRun");
    await access(target, constants.X_OK);
    console.log("Testing original AppImage SquashFS payload; the Type2 runtime itself remains UNVERIFIED.");
  }

  const wrapper = path.join(root, "run-appimage");
  await writeFile(wrapper, `#!/usr/bin/env bash
set -euo pipefail
unset LD_LIBRARY_PATH GDK_PIXBUF_MODULE_FILE GSETTINGS_SCHEMA_DIR LIBGL_DRIVERS_PATH LIBDECOR_PLUGIN_DIR
export APPIMAGE_EXTRACT_AND_RUN=1
exec "$SYNCPEER_TEST_APPIMAGE_TARGET" "$@"
`, { mode: 0o700 });

  const virtualDesktop = path.resolve("scripts/lan-test/virtual-desktop.sh");
  const code = await runWithPrivateSecretService("bash", [
    virtualDesktop, process.execPath, "--import", "tsx",
    path.resolve("node_modules/@wdio/cli/bin/wdio.js"), "run",
    path.resolve("scripts/lan-test/wdio.conf.ts"),
  ], {
    SYNCPEER_TEST_APPIMAGE_TARGET: target,
    SYNCPEER_LAN_APP_BINARY: wrapper,
    SYNCPEER_LAN_SPEC: "scripts/lan-test/release-smoke.spec.ts",
    SYNCPEER_LAN_DRIVER: "external",
    SYNCPEER_LAN_MOCHA_TIMEOUT: "300000",
    SYNCPEER_LAN_LOG_LEVEL: "error",
    XDG_DATA_DIRS: "/usr/share",
  });
  assert.equal(code, 0, "The AppImage packaged startup smoke test failed.");
} finally {
  if (payloadOnly) {
    const extractedRoot = path.join(root, "original-payload");
    // Keep the immutable SquashFS file permissions during the smoke, but
    // restore owner-writability before removing the isolated extraction.
    const madeWritable = spawnSync("chmod", ["-R", "u+rwX", extractedRoot], {
      timeout: 30_000, stdio: "ignore",
    });
    if (madeWritable.status !== 0) {
      console.warn("Unable to fully restore writable extraction permissions.");
    }
  }
  await rm(root, { recursive: true, force: true });
}
