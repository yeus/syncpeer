import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import {
  createPeerHello,
  deriveManualPairToken,
  derivePairToken,
  deriveServerCoordinatorToken,
  roleForPeer,
  LAN_COORDINATOR_PORT,
  LAN_DISCOVERY_PORT,
  type PeerHello,
  type RoleAssignment,
} from "./lan-test/protocol.ts";
import {
  discoverCandidates,
  discoverRoleAssignment,
  LAN_ROLE_DISCOVERY_TIMEOUT_MS,
  resolveAdvertisedAddress,
  resolveLocalAddress,
} from "./lan-test/discovery.ts";
import { LanCoordinator, coordinatorRequest } from "./lan-test/coordinator.ts";
import { readSourceState, requireCleanSource } from "./lan-test/source.ts";
import {
  createLanFixture,
  generateSyncthingIdentity,
  SYNCTHING_LOCAL_DISCOVERY_PORT,
  type RunningLanFixture,
} from "./lan-test/syncthing.ts";
import {
  createTemporaryNixosFirewall,
  installFirewallSignalCleanup,
  type TemporaryNixosFirewall,
} from "./lan-test/firewall.ts";
import { buildLanApp, runLanWdio } from "./lan-test/tauri-runner.ts";

const selfMode = process.argv.includes("--self");
const selfClientMode = process.argv.includes("--self-client");
const explicitServerMode = process.argv.includes("--server");
const explicitClientMode = process.argv.includes("--client");
const openFirewall = process.argv.includes("--open-firewall");
const keep = process.argv.includes("--keep");
if (explicitServerMode && explicitClientMode) {
  throw new Error("Choose either --server or --client, not both.");
}
const source = readSourceState();
if (!selfMode && !selfClientMode) requireCleanSource(source);

const nodePath = process.execPath;
const root = path.resolve(".tmp", "syncpeer-lan", new Date().toISOString().replace(/[:.]/g, "-"));
const coordinatorPort = Number(process.env.SYNCPEER_LAN_COORDINATOR_PORT ?? LAN_COORDINATOR_PORT);
const manualRoleValue = process.env.SYNCPEER_LAN_ROLE?.trim();
if (manualRoleValue && manualRoleValue !== "server" && manualRoleValue !== "client") {
  throw new Error("SYNCPEER_LAN_ROLE must be either server or client.");
}
const manualRole = manualRoleValue as "server" | "client" | undefined;
const manualPeer = process.env.SYNCPEER_LAN_PEER?.trim() || undefined;

const canonicalDeviceId = (value: string): string =>
  value.replace(/[^A-Z2-7]/gi, "").toUpperCase();

const prompt = async (message: string): Promise<string> => {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(message)).trim();
  } finally {
    terminal.close();
  }
};

const readDeviceIdPrompt = async (message: string): Promise<string> => {
  const deviceId = canonicalDeviceId(await prompt(message));
  if (deviceId.length !== 52 && deviceId.length !== 56) {
    throw new Error("Expected a 52- or 56-character Syncthing device ID.");
  }
  return deviceId;
};

const runClient = async (args: {
  coordinatorUrl: string;
  token: string;
  assignment: RoleAssignment;
  hello: PeerHello;
  explicitIds?: boolean;
  openFirewall: boolean;
  firewall?: TemporaryNixosFirewall;
}): Promise<number> => {
  const firewall = args.firewall ?? createTemporaryNixosFirewall(args.openFirewall);
  const closeFirewall = args.firewall ? null : installFirewallSignalCleanup(firewall);
  try {
    if (args.openFirewall) {
      firewall.open({ protocol: "udp", port: LAN_DISCOVERY_PORT });
      firewall.open({ protocol: "udp", port: SYNCTHING_LOCAL_DISCOVERY_PORT });
    }
    console.log("LAN role: Syncpeer client");
    console.log("Coordinator: " + args.coordinatorUrl);
    let coordinatorToken = args.token;
    let remoteDeviceId = process.env.SYNCPEER_LAN_REMOTE_DEVICE_ID?.trim() ?? "";
    if (args.explicitIds) {
      remoteDeviceId = await readDeviceIdPrompt("Enter the Syncthing server device ID: ");
      coordinatorToken = deriveServerCoordinatorToken(
        remoteDeviceId,
        process.env.SYNCPEER_LAN_PAIR,
      );
      console.log("Server device ID accepted: " + remoteDeviceId);
    }
    buildLanApp();
    const clientRoot = path.join(root, "client");
    fs.mkdirSync(clientRoot, { recursive: true });
    const appStateRoot = path.join(clientRoot, "app-state");
    fs.mkdirSync(appStateRoot, { recursive: true });
    const untrustedIdentity = generateSyncthingIdentity(
      path.join(clientRoot, "untrusted-identity"),
    );
    if (args.explicitIds) {
      console.log("Untrusted test identity ID: " + untrustedIdentity.deviceId);
      console.log("After the app opens, copy its This Device ID to the server terminal.");
    }
    const exitCode = await runLanWdio({
        SYNCPEER_LAN_COORDINATOR_URL: args.coordinatorUrl,
        SYNCPEER_LAN_COORDINATOR_TOKEN: coordinatorToken,
        SYNCPEER_LAN_CLIENT_ROOT: clientRoot,
        SYNCPEER_LAN_UNTRUSTED_DEVICE_ID: untrustedIdentity.deviceId,
        SYNCPEER_LAN_UNTRUSTED_CERT: untrustedIdentity.certPath,
        SYNCPEER_LAN_UNTRUSTED_KEY: untrustedIdentity.keyPath,
        SYNCPEER_LAN_REMOTE_DEVICE_ID: remoteDeviceId,
        SYNCPEER_LAN_MANUAL_IDS: args.explicitIds ? "1" : "",
        XDG_CONFIG_HOME: path.join(appStateRoot, "config"),
        XDG_DATA_HOME: path.join(appStateRoot, "data"),
        XDG_CACHE_HOME: path.join(appStateRoot, "cache"),
        SYNCPEER_DEFAULT_IDENTITY_DIR: path.join(appStateRoot, "identity"),
    });
    await coordinatorRequest({
      baseUrl: args.coordinatorUrl,
      token: coordinatorToken,
      method: "POST",
      pathname: "/v1/finalize",
      body: { status: exitCode === 0 ? "passed" : "failed" },
    }).catch((error) => {
      console.error("Could not publish client result: " + String(error));
    });
    return exitCode;
  } finally {
    await closeFirewall?.().catch((error) => {
      console.error("Firewall cleanup failed: " + String(error));
    });
  }
};

const runServer = async (args: {
  coordinatorUrl: string;
  token: string;
  serverHost: string;
  assignment: RoleAssignment;
  hello: PeerHello;
  self: boolean;
  explicitIds?: boolean;
  openFirewall: boolean;
}): Promise<number> => {
  console.log("LAN role: Syncthing fixture server");
  console.log("Server address: " + args.serverHost + ":" + coordinatorPort);
  const serverHome = path.join(root, "server", "syncthing");
  const serverIdentity = args.explicitIds
    ? generateSyncthingIdentity(serverHome)
    : null;
  const firewall = createTemporaryNixosFirewall(args.openFirewall);
  const closeFirewall = installFirewallSignalCleanup(firewall);
  try {
    if (args.openFirewall) {
      console.log("Temporarily opening the NixOS firewall for this test.");
      firewall.open({ protocol: "tcp", port: coordinatorPort });
      firewall.open({ protocol: "udp", port: LAN_DISCOVERY_PORT });
      firewall.open({ protocol: "udp", port: SYNCTHING_LOCAL_DISCOVERY_PORT });
    }
  } catch (error) {
    await closeFirewall().catch(() => undefined);
    throw error;
  }
  const coordinatorToken = serverIdentity
    ? deriveServerCoordinatorToken(serverIdentity.deviceId, process.env.SYNCPEER_LAN_PAIR)
    : args.token;
  const coordinator = new LanCoordinator(coordinatorToken);
  try {
    await coordinator.start("0.0.0.0", coordinatorPort);
  } catch (error) {
    await closeFirewall().catch(() => undefined);
    throw error;
  }
  coordinator.setAdvertisedBase(args.coordinatorUrl);
  console.log("Test coordinator: " + args.coordinatorUrl);
  if (serverIdentity) {
    console.log("Syncthing server device ID: " + serverIdentity.deviceId);
    console.log("Start the client with --client and enter this ID there.");
  }
  const discoveryAbort = args.explicitIds ? new AbortController() : null;
  const discoveryPromise = args.explicitIds
    ? discoverCandidates(args.hello, {
        timeoutMs: LAN_ROLE_DISCOVERY_TIMEOUT_MS,
        signal: discoveryAbort?.signal,
      }).catch((error) => {
        console.error("LAN server discovery failed: " + String(error));
        return [];
      })
    : null;
  const child = args.self
    ? spawn(nodePath, ["--experimental-strip-types", process.argv[1], "--self-client"], {
      stdio: "inherit",
      env: {
        ...process.env,
        SYNCPEER_LAN_COORDINATOR_URL: args.coordinatorUrl,
        SYNCPEER_LAN_COORDINATOR_TOKEN: coordinatorToken,
        ...(args.self ? { SYNCPEER_LAN_SELF: "1" } : {}),
      },
    })
    : undefined;
  let fixture: RunningLanFixture | null = null;
  coordinator.setActionHandler(async (action, details) => {
    if (!fixture) throw new Error("Syncthing fixture is not ready.");
    if (action === "switch-to-relay") {
      await fixture.switchToRelayOnly();
      return { status: "relay-only" };
    }
    if (action === "switch-transport") {
      const profile = String((details as { profile?: string } | undefined)?.profile ?? "");
      if (profile !== "tcp" && profile !== "quic" && profile !== "tcp-quic" && profile !== "relay") {
        throw new Error("Unknown Syncthing transport profile.");
      }
      await fixture.switchTransport(profile);
      return { status: profile };
    }
    if (action === "add-untrusted") {
      const deviceId = String((details as { deviceId?: string } | undefined)?.deviceId ?? "").trim();
      if (!deviceId) throw new Error("The untrusted profile requires a device ID.");
      await fixture.addUntrustedProfile(deviceId);
      return { status: "untrusted-ready" };
    }
    if (action === "verify-upload") {
      const uploaded = await fixture.verifyUploadedFile();
      return uploaded;
    }
    if (action === "churn") {
      const durationMs = Number((details as { durationMs?: number } | undefined)?.durationMs ?? 12000);
      return { ticks: await fixture.churn(Math.min(Math.max(durationMs, 1000), 30000)) };
    }
    if (action === "update-fixture-file") {
      const input = details as { path?: string; content?: string } | undefined;
      return fixture.updateFixtureFile(
        String(input?.path ?? ""),
        String(input?.content ?? ""),
      );
    }
    throw new Error("Unknown LAN fixture action: " + action);
  });
  try {
    const profile = args.explicitIds
      ? {
          deviceId: await readDeviceIdPrompt("Enter the trusted client device ID: "),
        }
      : await Promise.race([
          coordinator.waitForProfile("trusted", 180000),
          child
            ? new Promise<never>((_resolve, reject) => {
              child.once("exit", (code, signal) => {
                reject(new Error(
                  "LAN client exited before registering (code=" + String(code) + ", signal=" + String(signal) + ").",
                ));
              });
            })
            : new Promise<never>(() => undefined),
        ]);
    if (!profile.deviceId) throw new Error("A trusted client device ID is required.");
    const untrustedDeviceId = args.explicitIds
      ? await readDeviceIdPrompt("Enter the untrusted test identity ID: ")
      : undefined;
    fixture = await createLanFixture({
      root: path.join(root, "server"),
      serverHost: args.serverHost,
      trustedDeviceId: canonicalDeviceId(profile.deviceId),
      untrustedDeviceId: untrustedDeviceId || undefined,
      home: serverHome,
      mode: "direct",
    });
    if (args.openFirewall) {
      firewall.open({ protocol: "tcp", port: fixture.fixture.directPort });
      firewall.open({ protocol: "udp", port: fixture.fixture.directPort });
    }
    coordinator.setFixture(fixture.fixture);
    console.log(
      "Syncthing data endpoint: tcp://" +
      args.serverHost + ":" + fixture.fixture.directPort,
    );
    console.log("Syncthing Web UI: " + fixture.syncGuiUrl);
    console.log("Global discovery: " + fixture.fixture.discoveryServer);
    console.log("Syncthing server device ID: " + fixture.fixture.remoteDeviceId);
    console.log("Waiting for the Syncpeer client result...");
    const status = await coordinator.waitForFinalStatus(900000);
    return status === "passed" ? 0 : 1;
  } finally {
    discoveryAbort?.abort();
    await discoveryPromise;
    await fixture?.stop().catch((error) => console.error("Fixture cleanup failed: " + String(error)));
    await coordinator.close().catch(() => undefined);
    if (child) {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });
    }
    if (!keep) {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      console.log("LAN artifacts kept at " + root);
    }
    await closeFirewall().catch((error) => {
      console.error("Firewall cleanup failed: " + String(error));
    });
  }
};

const coordinatorUrlFor = (serverHost: string): string =>
  "http://" + serverHost + ":" + coordinatorPort;

const main = async (): Promise<number> => {
  if (selfClientMode) {
    const coordinatorUrl = process.env.SYNCPEER_LAN_COORDINATOR_URL;
    const token = process.env.SYNCPEER_LAN_COORDINATOR_TOKEN;
    if (!coordinatorUrl || !token) throw new Error("Self client coordinator environment is missing.");
    return runClient({
      coordinatorUrl,
      token,
      assignment: {} as RoleAssignment,
      hello: {} as PeerHello,
      explicitIds: false,
      openFirewall,
    });
  }

  const explicitRole = explicitServerMode ? "server" : explicitClientMode ? "client" : undefined;
  if (explicitRole) {
    const hello = createPeerHello({
      commit: source.commit,
      pairCode: process.env.SYNCPEER_LAN_PAIR,
      capabilities: { client: true, server: true },
    });
    const token = deriveManualPairToken(hello);
    if (explicitRole === "client") {
      const discoveryFirewall = openFirewall
        ? createTemporaryNixosFirewall(true)
        : undefined;
      const closeDiscoveryFirewall = discoveryFirewall
        ? installFirewallSignalCleanup(discoveryFirewall)
        : null;
      try {
        if (discoveryFirewall) {
          discoveryFirewall.open({ protocol: "udp", port: LAN_DISCOVERY_PORT });
          discoveryFirewall.open({ protocol: "udp", port: SYNCTHING_LOCAL_DISCOVERY_PORT });
        }
        console.log(
          manualPeer
            ? "Using SYNCPEER_LAN_PEER=" + manualPeer + "."
            : "Searching for the LAN test server via multicast (up to 15 minutes)...",
        );
        const progress = manualPeer
          ? null
          : setInterval(() => {
              console.log("Still searching for the LAN test server...");
            }, 10000);
        let discovered: Awaited<ReturnType<typeof discoverRoleAssignment>> | null = null;
        try {
          discovered = manualPeer
            ? null
            : await discoverRoleAssignment({
                hello,
                timeoutMs: LAN_ROLE_DISCOVERY_TIMEOUT_MS,
              });
        } finally {
          if (progress) clearInterval(progress);
        }
        const serverHost = manualPeer ?? discovered?.assignment.server.address;
        if (!serverHost) {
          throw new Error("Could not discover the LAN test server.");
        }
        return await runClient({
          coordinatorUrl: coordinatorUrlFor(serverHost),
          token,
          assignment: discovered?.assignment ?? ({} as RoleAssignment),
          hello,
          explicitIds: true,
          openFirewall,
          firewall: discoveryFirewall,
        });
      } finally {
        await closeDiscoveryFirewall?.().catch((error) => {
          console.error("Firewall cleanup failed: " + String(error));
        });
      }
    }
    const serverHost = process.env.SYNCPEER_LAN_HOST?.trim() || resolveAdvertisedAddress();
    return runServer({
      coordinatorUrl: coordinatorUrlFor(serverHost),
      token,
      serverHost,
      assignment: {} as RoleAssignment,
      hello,
      self: false,
      explicitIds: true,
      openFirewall,
    });
  }

  const hello = createPeerHello({
    commit: source.commit,
    pairCode: process.env.SYNCPEER_LAN_PAIR,
    capabilities: { client: true, server: true },
  });
  const discovered = await discoverRoleAssignment({
    hello,
    manualPeer: selfMode ? "127.0.0.1" : manualPeer,
    manualRole: selfMode ? "server" : manualRole,
  });
  const role = selfMode ? "server" : manualRole ?? roleForPeer(discovered.assignment, hello.peerId);
  const peer = role === "server" ? discovered.assignment.client : discovered.assignment.server;
  const token = manualPeer || manualRole || selfMode
    ? deriveManualPairToken(hello)
    : derivePairToken(hello, peer.hello);
  const serverHost = role === "server"
    ? await resolveLocalAddress(peer.address)
    : peer.address;
  const coordinatorUrl = coordinatorUrlFor(serverHost);

  if (role === "client") {
    return runClient({
      coordinatorUrl,
      token,
      assignment: discovered.assignment,
      hello,
      openFirewall,
    });
  }

  return runServer({
    coordinatorUrl,
    token,
    serverHost,
    assignment: discovered.assignment,
    hello,
    self: selfMode,
    openFirewall,
  });
};

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
