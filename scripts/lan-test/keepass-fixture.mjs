import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const keepassPackage = "keepass2android.keepass2android_nonet";
export const keepassVersion = "1.15-r6";
export const keepassFilename = "syncpeer-acceptance.kdbx";
// Only disposable synthetic credentials; never use a user's real database.
export const keepassPassword = "SyncpeerFixture123";
const apkSha256 = "3d6e098fce769b7efece159035234efc44a5bc15fd513101d70c6a8f0b489298";
const apkUrl = "https://github.com/PhilippC/keepass2android/releases/download/v1.15-r6/keepass2android.keepass2android_nonet-Signed-x64.apk";

export const getKeepassApk = async (root) => {
  const supplied = process.env.SYNCPEER_KEEPASS_APK?.trim();
  const apk = supplied || path.join(root, "keepass2android-offline-x64.apk");
  if (!supplied) {
    const response = await fetch(apkUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error("KeePass2Android download failed: " + response.status);
    fs.writeFileSync(apk, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256").update(fs.readFileSync(apk)).digest("hex");
  if (digest !== apkSha256) throw new Error("KeePass2Android pinned APK digest mismatch.");
  return apk;
};

const cli = (args, input = "") => execFileSync(
  process.env.SYNCPEER_KEEPASSXC_CLI || "keepassxc-cli",
  args, { input, encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] },
);

export const checkKeepassCli = () => cli(["--version"]).trim();
export const createKeepassFixture = (file) => {
  if (fs.existsSync(file)) throw new Error("Refusing to replace an existing database.");
  cli(["db-create", "--set-password", "--decryption-time", "100", file],
    keepassPassword + "\n" + keepassPassword + "\n");
  addKeepassEntry(file, "initial-fixture");
};
export const addKeepassEntry = (file, title) => {
  cli(["add", "-q", "-u", "synthetic-user", file, title], keepassPassword + "\n");
};
export const keepassEntries = (file) =>
  cli(["ls", "-q", "-R", file], keepassPassword + "\n").split(/\r?\n/).map(line => line.trim()).filter(Boolean);

// Incompressible deterministic bytes exercise multi-block storage and transfers.
export const keepassAttachmentName = "synthetic-attachment.bin";
export const keepassAttachment = (size = 4 * 1024 * 1024 + 17) => {
  const bytes = Buffer.alloc(size);
  let state = 0x13579bdf;
  for (let i = 0; i < size; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    bytes[i] = state & 255;
  }
  return bytes;
};

export const importKeepassAttachment = (database, source) =>
  cli(["attachment-import", "-q", database, "initial-fixture", keepassAttachmentName, source],
    keepassPassword + "\n");

export const verifyKeepassAttachment = (database, destination, expected = keepassAttachment()) => {
  if (fs.existsSync(destination)) throw new Error("Refusing to overwrite attachment export.");
  try {
    cli(["attachment-export", "-q", database, "initial-fixture", keepassAttachmentName, destination],
      keepassPassword + "\n");
    if (!fs.readFileSync(destination).equals(expected)) throw new Error("KDBX attachment changed.");
  } finally { fs.rmSync(destination, { force: true }); }
};
