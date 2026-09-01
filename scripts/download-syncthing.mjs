import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Download a pinned Syncthing release into the .tools directory.
// Set SYNCTHING_VERSION to override the default.
const version = process.env.SYNCTHING_VERSION ?? "v2.1.2";
const relayVersion = process.env.SYNCTHING_RELAY_VERSION ?? "v2.1.3";

const platformMap = {
  linux: "linux",
  darwin: "macos",
};
const archMap = {
  x64: "amd64",
  arm64: "arm64",
};

const platform = platformMap[process.platform];
const arch = archMap[process.arch];

if (!platform || !arch) {
  console.error(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
  process.exit(1);
}

const toolsDir = path.resolve(".tools");

fs.mkdirSync(toolsDir, { recursive: true });

const ensureBinary = (binaryName, binaryVersion) => {
  const extension = platform === "linux" ? ".tar.gz" : ".zip";
  const fileName = `${binaryName}-${platform}-${arch}-${binaryVersion}${extension}`;
  const repository = binaryName === "strelaysrv" ? "syncthing/relaysrv" : "syncthing/syncthing";
  const url = `https://github.com/${repository}/releases/download/${binaryVersion}/${fileName}`;
  const checksumUrl = `https://github.com/${repository}/releases/download/${binaryVersion}/sha256sum.txt.asc`;
  const archivePath = path.join(toolsDir, fileName);
  const extractDir = path.join(toolsDir, `${binaryName}-${platform}-${arch}-${binaryVersion}`);
  const binPath = path.join(extractDir, binaryName);

  if (fs.existsSync(binPath)) {
    console.log(`${binaryName} already downloaded at ${binPath}`);
    return;
  }

  const checksumManifest = execFileSync("curl", ["-fsSL", checksumUrl], { encoding: "utf8" });
  const checksumLine = checksumManifest
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(`  ${fileName}`));
  if (!checksumLine) {
    throw new Error(`No checksum was published for ${fileName}.`);
  }
  const expectedChecksum = checksumLine.split(/\s+/)[0].toLowerCase();

  console.log(`Downloading ${url}`);
  execFileSync("curl", ["-fL", "-o", archivePath, url], { stdio: "inherit" });

  const actualChecksum = createHash("sha256")
    .update(fs.readFileSync(archivePath))
    .digest("hex");
  if (actualChecksum !== expectedChecksum) {
    fs.unlinkSync(archivePath);
    throw new Error(`Checksum mismatch for ${fileName}.`);
  }
  console.log(`Verified SHA-256 for ${fileName}`);

  console.log(`Extracting ${archivePath}`);
  if (extension === ".tar.gz") {
    execFileSync("tar", ["-xzf", archivePath, "-C", toolsDir], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", archivePath, "-d", toolsDir], { stdio: "inherit" });
  }

  if (!fs.existsSync(binPath)) {
    throw new Error(`Expected binary not found at ${binPath}`);
  }

  fs.chmodSync(binPath, 0o755);
  console.log(`${binaryName} downloaded to ${binPath}`);
};

ensureBinary("syncthing", version);
ensureBinary("strelaysrv", relayVersion);
