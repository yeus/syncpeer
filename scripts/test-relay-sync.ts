import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { X509Certificate } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { useTemporaryMetadataRoot } from "./node-storage-fixture.ts";
import { startLocalRelay } from "./lan-test/relay.ts";
import { generateSyncthingIdentity } from "./lan-test/syncthing.ts";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";
import { computeDeviceId } from "../packages/core/dist/core/transport/node.js";
import { createSyncpeerBrowserClient } from "../packages/core/dist/ui/browserClient.js";
import { createNodeFolderReplica } from "../packages/core/dist/sync/nodeReplica.js";

useTemporaryMetadataRoot();

test("failed pinned discovery releases cancellation listeners before retrying", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synthetic-discovery-"));
  const identity = generateSyncthingIdentity(root);
  const server = createServer({ cert: await readFile(identity.certPath, "utf8"),
    key: await readFile(identity.keyPath, "utf8") });
  const stop = new AbortController();
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(createNodeHostAdapter().discoveryFetch(`https://127.0.0.1:${address.port}/v2/`,
      { pinServerDeviceId: "SYNTHETIC-WRONG-PIN", signal: stop.signal }), /certificate ID mismatch/);
    assert.equal(getEventListeners(stop.signal, "abort").length, 0);
  } finally {
    stop.abort();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 12000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("ordinary browser clients discover relay presence and synchronize encrypted folders without direct connectivity",
  { timeout: 45000 }, async () => {
    const relay = await startLocalRelay();
    const adapter = createNodeHostAdapter();
    const identities = await Promise.all(["one", "two", "discovery"].map(async name => {
      const identity = generateSyncthingIdentity(path.join(relay.root, name));
      return { deviceId: identity.deviceId, certPem: await readFile(identity.certPath, "utf8"),
        keyPem: await readFile(identity.keyPath, "utf8") };
    }));
    const [one, two] = identities.slice(0, 2).sort((a, b) => a.deviceId.replaceAll("-", "")
      .localeCompare(b.deviceId.replaceAll("-", "")));
    const discovery = identities[2];
    const addresses = new Map<string, string[]>();
    const requests: Array<{ method: string; authenticated: boolean }> = [];
    const server = createServer({ cert: discovery.certPem, key: discovery.keyPem,
      requestCert: true, rejectUnauthorized: false }, async (request, response) => {
      const url = new URL(request.url!, "https://synthetic.invalid");
      const certificate = (request.socket as TLSSocket).getPeerCertificate();
      requests.push({ method: request.method!, authenticated: !!certificate.raw });
      if (url.pathname === "/endpoint") {
        response.end(JSON.stringify({ relays: [{ url: relay.relayAddress }] })); return;
      }
      if (request.method === "POST") {
        if (!certificate.raw) { response.writeHead(403).end(); return; }
        let body = "";
        for await (const chunk of request) body += chunk;
        addresses.set(computeDeviceId(new X509Certificate(certificate.raw).raw).replaceAll("-", ""),
          ["tcp://127.0.0.1:1", ...JSON.parse(body).addresses]);
        response.writeHead(204, { "Reannounce-After": "1800" }).end(); return;
      }
      const found = addresses.get((url.searchParams.get("device") ?? "").replaceAll("-", ""));
      response.writeHead(found ? 200 : 404).end(JSON.stringify({ addresses: found ?? [] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `https://127.0.0.1:${address.port}`;
    const discoveryServer = `${base}/v2/?id=${discovery.deviceId}`;
    const relayPoolUrl = `${base}/endpoint?id=${discovery.deviceId}`;
    let directAttempts = 0;
    const clients: ReturnType<typeof createSyncpeerBrowserClient>[] = [];
    try {
      const makePeer = async (identity: typeof one, name: string, remote: typeof two) => {
        const directory = path.join(relay.root, name);
        await mkdir(directory);
        await writeFile(path.join(directory, `${name}.txt`), `synthetic-${name}`);
        const replica = await createNodeFolderReplica(directory, name === "a" ? "1" : "2");
        const sharedFolders = [{ id: "synthetic-relay-folder", replica,
          encryption: { mode: "encrypted" as const, password: "synthetic-relay-folder-password" } }];
        const client = createSyncpeerBrowserClient({ hostAdapter: { ...adapter,
          log: () => {}, discoverLocalCandidates: async () => [],
          connectTls: async () => { directAttempts++; throw new Error("Synthetic direct path unavailable"); },
          listenTls: options => adapter.listenTls!({ ...options, host: "127.0.0.1", port: 0 }),
        }, platformAdapter: { readDefaultIdentity: async () => identity } });
        clients.push(client);
        return { directory, client, options: { host: "", port: 22000, remoteId: remote.deviceId,
          discoveryMode: "automatic" as const, discoveryServer, relayPoolUrl,
          deviceName: `synthetic-${name}`, timeoutMs: 15000, sharedFolders } };
      };
      const high = await makePeer(two, "b", one);
      const low = await makePeer(one, "a", two);
      const waiting = high.client.connectAndGetOverview(high.options);
      void waiting.catch(() => undefined);
      await until(() => addresses.has(two.deviceId.replaceAll("-", "")), "The waiting peer did not announce its relay");
      const connected = await low.client.connectAndGetOverview(low.options);
      assert.equal(connected.transportKind, "relay");
      await waiting;
      await until(async () => (await readFile(path.join(low.directory, "b.txt"), "utf8").catch(() => "")) === "synthetic-b",
        "Encrypted relay folder did not converge from the incoming peer");
      await until(async () => (await readFile(path.join(high.directory, "a.txt"), "utf8").catch(() => "")) === "synthetic-a",
        "Encrypted relay folder did not converge from the outgoing peer");
      assert.ok(directAttempts > 0, "Direct dialing must fail before relay fallback proves connectivity");
      assert.ok(requests.filter(request => request.method === "POST").length >= 2);
      assert.ok(requests.filter(request => request.method === "POST").every(request => request.authenticated));
      await relay.restart();
      await writeFile(path.join(low.directory, "after-connect.txt"), "synthetic-live-edit");
      await until(async () => (await readFile(path.join(high.directory, "after-connect.txt"), "utf8").catch(() => "")) === "synthetic-live-edit",
        "Encrypted file sync did not recover after the relay restarted");
    } finally {
      await Promise.all(clients.map(client => client.disconnect()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await relay.close();
    }
  });
