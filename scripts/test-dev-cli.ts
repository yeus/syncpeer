import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  isValidSyncthingDeviceId,
  normalizeDeviceId,
} from "../packages/core/src/ui/helpers.ts";
import {
  LAN_FIXTURE_BLOB_SIZE,
  LAN_FIXTURE_FOLDER_ID,
  LAN_FIXTURE_HELLO_CONTENT,
} from "./lan-test/fixture-data.ts";
import {
  getDefaultDiscoveryServer,
  normalizeDiscoveryServer,
} from "../packages/core/src/ui/discoveryServer.ts";
import {
  buildDiagnosticsRegistry,
  runDiagnosticsTests,
  type DiagnosticsBuiltinTest,
} from "../packages/shared/modules/diagnosticsRunner.ts";
import { sanitizeDiagnosticArtifact } from "../packages/shared/modules/diagnosticSanitizer.ts";

const fixtureFolderId = LAN_FIXTURE_FOLDER_ID;
const fixtureHello = LAN_FIXTURE_HELLO_CONTENT;
const fixtureBlobSize = LAN_FIXTURE_BLOB_SIZE;

const npmCommand = (): string => process.platform === "win32" ? "npm.cmd" : "npm";

const clientRoot = (): string => path.resolve(
  process.env.SYNCPEER_LAN_CLIENT_ROOT ?? ".tmp/syncpeer-dev-client",
);

const reportRoot = (): string => path.join(clientRoot(), "diagnostics");

const discoveryServer = (): string => normalizeDiscoveryServer(
  process.env.SYNCPEER_LAN_DISCOVERY_SERVER?.trim() || getDefaultDiscoveryServer(),
);

const clientEnvironment = (): NodeJS.ProcessEnv => {
  const configuredHome = process.env.SYNCPEER_DEV_CLIENT_CONFIG_HOME?.trim();
  return {
    ...process.env,
    ...(configuredHome
      ? { XDG_CONFIG_HOME: path.resolve(configuredHome) }
      : {}),
  };
};

const readServerDeviceId = (): string => {
  const configured = process.env.SYNCPEER_DEV_SERVER_DEVICE_ID?.trim();
  const savedPath = path.join(clientRoot(), "server-device-id");
  const saved = fs.existsSync(savedPath) ? fs.readFileSync(savedPath, "utf8").trim() : "";
  const deviceId = normalizeDeviceId(configured || saved);
  if (!isValidSyncthingDeviceId(deviceId)) {
    throw new Error(
      "Set SYNCPEER_DEV_SERVER_DEVICE_ID or run the client once to save the server ID.",
    );
  }
  return deviceId;
};

const cliEntry = (): string => path.resolve("packages/cli/dist/main.js");

const buildCli = (): void => {
  execFileSync(npmCommand(), ["run", "build:cli"], { stdio: "inherit" });
};

const runCli = (args: string[], env: NodeJS.ProcessEnv): string => {
  const result = spawnSync(process.execPath, [cliEntry(), ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`CLI exited with ${result.status}:\n${output}`);
  }
  return output;
};

const remoteArgs = (serverDeviceId: string): string[] => [
  "--remote-id", serverDeviceId,
  "--discovery-server", discoveryServer(),
  "--relay-only",
  "--timeout-ms", process.env.SYNCPEER_LAN_TIMEOUT_MS?.trim() || "120000",
];

const runRemoteCli = (
  serverDeviceId: string,
  command: string,
  commandArgs: string[] = [],
): string => runCli([...remoteArgs(serverDeviceId), command, ...commandArgs], clientEnvironment());

const requireOutput = (output: string, expected: string, label: string): void => {
  if (!output.includes(expected)) {
    throw new Error(`${label} did not contain "${expected}".\n${output}`);
  }
};

const sha256File = (filePath: string): string => createHash("sha256")
  .update(fs.readFileSync(filePath))
  .digest("hex");

const fixtureBlobHash = (): string => {
  const hash = createHash("sha256");
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < fixtureBlobSize; offset += chunkSize) {
    const chunk = Buffer.alloc(Math.min(chunkSize, fixtureBlobSize - offset));
    for (let index = 0; index < chunk.length; index += 1) {
      chunk[index] = (offset + index) % 251;
    }
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const diagnosticsTests = (serverDeviceId: string): DiagnosticsBuiltinTest[] => {
  const root = reportRoot();
  const env = clientEnvironment();
  const base = (command: string, args: string[] = []) =>
    runRemoteCli(serverDeviceId, command, args);
  const test = (
    testName: string,
    func: DiagnosticsBuiltinTest["func"],
    timeoutMs = 90_000,
  ): DiagnosticsBuiltinTest => ({
    testName,
    func: Object.assign(func, { timeoutMs }),
    sourcePath: "scripts/test-dev-cli.ts",
  });

  return [
    test("cliIdentity", () => {
      const output = runCli(["local-id"], env);
      requireOutput(output, "deviceId", "CLI identity check");
      return { output };
    }),
    test("globalDiscovery", () => {
      const output = base("global-discovery-test");
      requireOutput(output, "candidate\trelay", "Global discovery check");
      return { output };
    }),
    test("listRemoteFolders", () => {
      const output = base("list");
      requireOutput(output, `${fixtureFolderId}\trw`, "Remote folder list check");
      return { folderId: fixtureFolderId, output };
    }),
    test("browseRemoteFolder", () => {
      const output = base("files", [fixtureFolderId]);
      for (const expected of ["hello.txt", "nested/", "blob.bin"]) {
        requireOutput(output, expected, "Remote folder browse check");
      }
      return { folderId: fixtureFolderId, output };
    }),
    test("downloadHelloFile", () => {
      fs.mkdirSync(root, { recursive: true });
      const outputPath = path.join(root, "cli-hello.txt");
      base("download", [fixtureFolderId, "hello.txt", outputPath]);
      const content = fs.readFileSync(outputPath, "utf8");
      if (content !== fixtureHello) {
        throw new Error(`hello.txt content mismatch: ${JSON.stringify(content)}`);
      }
      return { outputPath, sha256: sha256File(outputPath) };
    }),
    test("downloadLargeFile", () => {
      fs.mkdirSync(root, { recursive: true });
      const outputPath = path.join(root, "cli-blob.bin");
      const startedAt = Date.now();
      base("download", [fixtureFolderId, "blob.bin", outputPath]);
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      const actualHash = sha256File(outputPath);
      const expectedHash = fixtureBlobHash();
      if (actualHash !== expectedHash) {
        throw new Error(`blob.bin hash mismatch: expected ${expectedHash}, got ${actualHash}`);
      }
      const bytes = fs.statSync(outputPath).size;
      return {
        outputPath,
        bytes,
        sha256: actualHash,
        elapsedMs,
        mibPerSecond: bytes / 1024 / 1024 * 1000 / elapsedMs,
      };
    }, 240_000),
    test("uploadAndDownloadRoundTrip", async () => {
      fs.mkdirSync(root, { recursive: true });
      const name = `cli-${Date.now()}.txt`;
      const remotePath = `syncpeer-test-runs/${name}`;
      const sourcePath = path.join(root, name);
      const roundTripPath = path.join(root, `roundtrip-${name}`);
      const content = `Syncpeer CLI round trip ${new Date().toISOString()}\n`;
      fs.writeFileSync(sourcePath, content, "utf8");
      base("upload", [
        "--serve-ms",
        "120000",
        fixtureFolderId,
        sourcePath,
        remotePath,
      ]);
      const deadline = Date.now() + 90_000;
      let lastError = "";
      while (Date.now() < deadline) {
        try {
          base("download", [fixtureFolderId, remotePath, roundTripPath]);
          const downloaded = fs.readFileSync(roundTripPath, "utf8");
          if (downloaded === content) return { remotePath, bytes: downloaded.length };
          lastError = "Downloaded content did not match the uploaded content.";
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        await delay(1000);
      }
      throw new Error(`Upload round trip timed out: ${lastError}`);
    }, 240_000),
    test("reconnectsRepeatedly", async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const output = base("list");
        requireOutput(output, `${fixtureFolderId}\trw`, `Reconnect ${attempt}`);
        await delay(500);
      }
      return { attempts: 3 };
    }, 180_000),
  ];
};

const run = async (): Promise<void> => {
  buildCli();
  const serverDeviceId = readServerDeviceId();
  const startedAtMs = Date.now();
  const registry = buildDiagnosticsRegistry({
    modules: [],
    builtins: diagnosticsTests(serverDeviceId),
  });
  const results = await runDiagnosticsTests(registry.tests, {
    details: true,
    timeoutMs: 120_000,
    context: { allowLongRun: true },
    onProgress: ({ phase, test, ok }) => {
      if (phase === "start") console.log(`CLI diagnostic started: ${test}`);
      else console.log(`CLI diagnostic ${ok ? "passed" : "failed"}: ${test}`);
    },
  });
  const failed = results.filter((result) => !result.ok);
  const report = {
    report_date: new Date().toISOString(),
    duration_ms: Date.now() - startedAtMs,
    phase: "remote-cli",
    server_device_id: serverDeviceId,
    discovery_server: discoveryServer(),
    relay_only: true,
    summary: {
      all_passed: failed.length === 0,
      passed: results.length - failed.length,
      failed: failed.length,
    },
    results,
  };
  fs.mkdirSync(reportRoot(), { recursive: true });
  const sanitizedReport = sanitizeDiagnosticArtifact(report);
  fs.writeFileSync(
    path.join(reportRoot(), "cli-report.json"),
    JSON.stringify(sanitizedReport, null, 2) + "\n",
    "utf8",
  );
  console.log(JSON.stringify(sanitizedReport, null, 2));
  if (failed.length > 0) process.exitCode = 1;
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
