import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createLanFixture, generateSyncthingIdentity } from "./lan-test/syncthing.ts";

const root = await mkdtemp(path.join(tmpdir(), "syncpeer-folder-integration-"));
let fixture: Awaited<ReturnType<typeof createLanFixture>> | undefined;
try {
  const identityRoot = path.join(root, "identity");
  const identity = generateSyncthingIdentity(identityRoot);
  fixture = await createLanFixture({ root: path.join(root, "server"), serverHost: "127.0.0.1", trustedDeviceId: identity.deviceId, mode: "direct", encryptedFolderType: "sendreceive" });
  const selected = path.join(root, "selected");
  await mkdir(selected);
  await writeFile(path.join(selected, "upload.txt"), "folder upload confirmed before exit\n");
  const options = ["packages/cli/dist/main.js", "--cert", path.join(identityRoot, "cert.pem"), "--key", path.join(identityRoot, "key.pem"),
    "--host", "127.0.0.1", "--port", String(fixture.fixture.directPort), "--remote-id", fixture.fixture.remoteDeviceId, "--discovery-mode", "direct"];
  const cli = async (connection: string[], ...args: string[]) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...connection, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    child.stdout.resume();
    child.stderr.on("data", bytes => { errors += String(bytes); });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Folder CLI timed out")); }, 180000);
    child.on("error", reject);
    child.on("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Folder CLI failed (${code}): ${errors}`));
    });
  });
  await cli(options, "sync-folder", fixture.fixture.folderId, selected, "--once");
  assert.equal(await readFile(path.join(fixture.sharePath, "upload.txt"), "utf8"), "folder upload confirmed before exit\n");
  assert.equal(await readFile(path.join(selected, "hello.txt"), "utf8"), await readFile(path.join(fixture.sharePath, "hello.txt"), "utf8"));
  await cli(options, "delete-file", fixture.fixture.folderId, selected, "hello.txt");
  await assert.rejects(() => readFile(path.join(fixture.sharePath, "hello.txt")), { code: "ENOENT" });
  await assert.rejects(() => readFile(path.join(selected, "hello.txt")), { code: "ENOENT" });
  const service = spawn(process.execPath, [...options, "sync-folder", fixture.fixture.folderId, selected], { stdio: ["ignore", "pipe", "pipe"] });
  service.stderr.resume();
  const exited = new Promise<number | null>(resolve => service.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Folder subscription did not become ready")), 30000);
      let output = "";
      service.stdout.on("data", bytes => {
        output += String(bytes);
        if (output.includes("Folder subscription active.")) { clearTimeout(timer); resolve(); }
      });
      service.once("error", error => { clearTimeout(timer); reject(error); });
    });
    await cli(options, "unsubscribe-folder", selected);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Unsubscribed service did not exit")), 10000);
      })]), 0);
    } finally { clearTimeout(timer); }
    await assert.rejects(() => readFile(path.join(selected, "upload.txt")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(fixture.sharePath, "upload.txt"), "utf8"), "folder upload confirmed before exit\n");
  } finally { service.kill("SIGTERM"); await exited; }
  const encryptedIdentityRoot = path.join(root, "encrypted-identity");
  const encryptedIdentity = generateSyncthingIdentity(encryptedIdentityRoot);
  await fixture.addUntrustedProfile(encryptedIdentity.deviceId);
  const encryptedOptions = options.map(value => value === path.join(identityRoot, "cert.pem")
    ? path.join(encryptedIdentityRoot, "cert.pem") : value === path.join(identityRoot, "key.pem")
      ? path.join(encryptedIdentityRoot, "key.pem") : value);
  encryptedOptions.push("--folder-password", `${fixture.fixture.encryptedFolderId}=${fixture.fixture.encryptedPassword}`);
  const encryptedSelected = path.join(root, "encrypted-selected");
  await mkdir(encryptedSelected);
  await writeFile(path.join(encryptedSelected, "upload.txt"), "encrypted upload\n");
  await cli(encryptedOptions, "sync-folder", fixture.fixture.encryptedFolderId, encryptedSelected, "--once");
  assert.equal(await readFile(path.join(fixture.encryptedSharePath, "upload.txt"), "utf8"), "encrypted upload\n");
  await cli(encryptedOptions, "delete-file", fixture.fixture.encryptedFolderId, encryptedSelected, "secret.txt");
  await assert.rejects(() => readFile(path.join(fixture.encryptedSharePath, "secret.txt")), { code: "ENOENT" });
  console.log("Folder CLI plaintext/encrypted publication, remote deletion, and active unsubscribe passed against managed Syncthing.");
} finally {
  await fixture?.stop();
  await rm(root, { recursive: true, force: true });
}
