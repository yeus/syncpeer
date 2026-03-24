import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Download a pinned Syncthing release into the .tools directory.
// Set SYNCTHING_VERSION to override the default.
const version = process.env.SYNCTHING_VERSION ?? "v1.27.8";

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

const fileName = `syncthing-${platform}-${arch}-${version}.tar.gz`;
const url = `https://github.com/syncthing/syncthing/releases/download/${version}/${fileName}`;

const toolsDir = path.resolve(".tools");
const archivePath = path.join(toolsDir, fileName);
const extractDir = path.join(toolsDir, `syncthing-${platform}-${arch}-${version}`);
const binPath = path.join(extractDir, "syncthing");

fs.mkdirSync(toolsDir, { recursive: true });

if (fs.existsSync(binPath)) {
  console.log(`Syncthing already downloaded at ${binPath}`);
  process.exit(0);
}

console.log(`Downloading ${url}`);
execFileSync("curl", ["-L", "-o", archivePath, url], { stdio: "inherit" });

console.log(`Extracting ${archivePath}`);
execFileSync("tar", ["-xzf", archivePath, "-C", toolsDir], { stdio: "inherit" });

if (!fs.existsSync(binPath)) {
  console.error(`Expected binary not found at ${binPath}`);
  process.exit(1);
}

fs.chmodSync(binPath, 0o755);
console.log(`Syncthing downloaded to ${binPath}`);
