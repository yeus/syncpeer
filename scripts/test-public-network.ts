import assert from "node:assert/strict";
import dns from "node:dns";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";
import { createNodeFolderReplica } from "../packages/core/dist/sync/nodeReplica.js";
import { createSyncpeerBrowserClient } from "../packages/core/dist/ui/browserClient.js";
import { getDefaultDiscoveryServer } from "../packages/core/dist/ui/discoveryServer.js";
import { generateSyncthingIdentity } from "./lan-test/syncthing.ts";

dns.setDefaultResultOrder("ipv4first");

if (process.env.SYNCPEER_RUN_EXTERNAL_CHECKS !== "1") {
  console.log("Public-network acceptance skipped; set SYNCPEER_RUN_EXTERNAL_CHECKS=1 to opt in.");
  process.exit(0);
}

const relayPoolUrl = "https://relays.syncthing.net/endpoint";
const discoveryServer = getDefaultDiscoveryServer();
const root = await mkdtemp(path.join(tmpdir(), "syncpeer-public-network-"));
const control = createNodeHostAdapter();
const clients: ReturnType<typeof createSyncpeerBrowserClient>[] = [];

const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(message + (lastError ? `: ${String(lastError)}` : ""));
};

try {

  const identities = await Promise.all(["one", "two"].map(async name => {
    const identity = generateSyncthingIdentity(path.join(root, name, "identity"));
    return {
      deviceId: identity.deviceId,
      certPem: await readFile(identity.certPath, "utf8"),
      keyPem: await readFile(identity.keyPath, "utf8"),
    };
  }));
  const [one, two] = identities.sort((left, right) =>
    left.deviceId.replaceAll("-", "").localeCompare(right.deviceId.replaceAll("-", "")));

  const events: Array<{ peer: string; event: string }> = [];
  const makePeer = async (
    identity: typeof one,
    remote: typeof two,
    name: string,
  ) => {
    const directory = path.join(root, name, "folder");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${name}.txt`), `public-${name}`);
    const replica = await createNodeFolderReplica(directory, name === "a" ? "1" : "2");
    const base = createNodeHostAdapter();
    const adapter = {
      ...base,
      discoverLocalCandidates: async () => [],
      log: (event: string) => events.push({ peer: name, event }),
    };
    const client = createSyncpeerBrowserClient({
      hostAdapter: adapter,
      platformAdapter: { readDefaultIdentity: async () => identity },
    });
    clients.push(client);
    return {
      directory,
      client,
      options: {
        host: "",
        port: 22000,
        remoteId: remote.deviceId,
        discoveryMode: "global" as const,
        discoveryServer,
        relayPoolUrl,
        relayOnly: true,
        enableRelayFallback: true,
        deviceName: `public-${name}`,
        timeoutMs: 180_000,
        sharedFolders: [{
          id: "syncpeer-public-network",
          replica,
          encryption: {
            mode: "encrypted" as const,
            password: "syncpeer-public-network-password",
          },
        }],
      },
    };
  };

  const a = await makePeer(one, two, "a");
  const b = await makePeer(two, one, "b");

  const waitingForB = b.client.connectAndGetOverview(b.options);
  void waitingForB.catch(() => undefined);
  await waitUntil(
    () => events.some(entry => entry.peer === "b" && entry.event === "core.relay.announced"),
    60_000,
    "Peer B did not announce its public relay address.",
  );

  const lookup = new URL(discoveryServer);
  const pinServerDeviceId = lookup.searchParams.get("id")?.trim();
  lookup.searchParams.delete("id");
  lookup.searchParams.set("device", two.deviceId);
  await waitUntil(async () => {
    const response = await control.discoveryFetch(lookup.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      pinServerDeviceId,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return false;
    assert.equal(response.ok, true, `Official discovery lookup failed with ${response.status}.`);
    const body = await response.json() as { addresses?: string[] };
    return body.addresses?.some(address => address.startsWith("relay://")) ?? false;
  }, 60_000, "Official discovery did not publish peer B's public relay address.");

  const connectedA = await a.client.connectAndGetOverview(a.options);
  assert.equal(connectedA.transportKind, "relay");
  assert.match(connectedA.connectedVia ?? "", /^relay:\/\//);
  const connectedB = await waitingForB;
  assert.equal(connectedB.transportKind, "relay");

  await waitUntil(
    async () => await readFile(path.join(a.directory, "b.txt"), "utf8").catch(() => "") === "public-b",
    120_000,
    "Public relay did not converge peer B's encrypted payload to peer A.",
  );
  await waitUntil(
    async () => await readFile(path.join(b.directory, "a.txt"), "utf8").catch(() => "") === "public-a",
    120_000,
    "Public relay did not converge peer A's encrypted payload to peer B.",
  );

  console.log(
    "Public-network acceptance passed: official discovery, pool-provided public relay, " +
    "relay-only session, and bidirectional encrypted convergence.",
  );
} finally {
  await Promise.all(clients.map(client => client.disconnect().catch(() => undefined)));
  await rm(root, { recursive: true, force: true });
}
