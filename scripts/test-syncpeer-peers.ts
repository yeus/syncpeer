import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeDeviceId } from "../packages/core/dist/core/transport/node.js";
import { createNodeSyncpeerClient, createNodeHostAdapter, createNodeFolderSyncStorage, listenNodePeer } from "../packages/core/dist/node.js";
import { createSyncpeerCoreClient } from "../packages/core/dist/client.js";
import { ClusterConfig, FrameParser, MessageTypeValues, encodeMessageFrame, type BepIndex, type BepClusterConfig } from "../packages/core/dist/core/protocol/bep.js";
import type { SyncpeerSessionHandle } from "../packages/core/src/client.ts";
import { createNodeFolderReplica } from "../packages/core/dist/sync/nodeReplica.js";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { createCiphertextReplica, deriveUntrustedFolderCrypto, writeEncryptedDiskFile,
  loadCiphertextDiskMetadata, readCiphertextBlock } from "@syncpeer/core/filesystem";
import { memoryReplicaStorage } from "./lan-test/replica-storage.ts";

async function createTestPeerIdentity(root: string, name: string) {
  const cert = path.join(root, `${name}.pem`);
  const key = path.join(root, `${name}.key`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-days", "1", "-subj", "/CN=synthetic-peer", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const certPem = await readFile(cert, "utf8");
  return { certPem, keyPem: await readFile(key, "utf8"), deviceId: computeDeviceId(new X509Certificate(certPem).raw) };
}

test("locked Syncpeer peers transfer ciphertext over TLS without folder keys", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-locked-peers-"));
  const crypto = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const folderIdentity = { folderId: crypto.folderId, passwordToken: crypto.passwordToken };
  const makeReplica = async (name: string) => {
    const { storage } = memoryReplicaStorage();
    let transaction = Promise.resolve();
    const replica = createCiphertextReplica(storage, { identity: folderIdentity,
      withLock: operation => {
        const task = transaction.then(operation);
        transaction = task.then(() => {}, () => {});
        return task;
      }, checkHealth: async () => {} });
    const content = new Uint8Array(1024).fill(name === "a" ? 3 : 7);
    let disk = new Uint8Array();
    const encrypted = await writeEncryptedDiskFile({ folderKey: crypto.folderKey, randomBytes,
      fileInfo: { name, type: 0, size: content.length, version: { counters: [{ id: "42", value: "1" }] },
        blocks: [{ offset: 0, size: content.length, hash: sha256(content) }] },
      source: { size: content.length, readRange: async (offset, size) => content.slice(offset, offset + size) },
      createSink: async (_info, size) => {
        disk = new Uint8Array(size);
        return { write: async (offset, chunk) => { disk.set(chunk, offset); }, commit: async () => {}, abort: async () => assert.fail() };
      } });
    const source = { size: disk.length, readRange: async (offset: number, size: number) => disk.slice(offset, offset + size) };
    const metadata = await loadCiphertextDiskMetadata(source, encrypted.name);
    await replica.receive(folderIdentity, encrypted, (offset, size, token) => readCiphertextBlock(source, metadata, offset, size, token));
    return { replica, encrypted, source, metadata };
  };
  let listener: Awaited<ReturnType<typeof listenNodePeer>> | undefined;
  let incoming: SyncpeerSessionHandle | undefined;
  let outgoing: SyncpeerSessionHandle | undefined;
  try {
    const [a, b] = await Promise.all([createTestPeerIdentity(root, "a"), createTestPeerIdentity(root, "b")]);
    const [localA, localB, update] = await Promise.all([makeReplica("a"), makeReplica("b"), makeReplica("c")]);
    crypto.folderKey.fill(0); // Neither session receives passwords or a folder key.
    const accepted = Promise.withResolvers<SyncpeerSessionHandle>();
    const shared = (replica: typeof localA.replica) => [{ id: folderIdentity.folderId, ciphertextReplica: replica,
      encryption: { mode: "ciphertext" as const, passwordToken: folderIdentity.passwordToken } }];
    listener = await listenNodePeer({ ...a, host: "127.0.0.1", port: 0, expectedDeviceId: b.deviceId,
      sharedFolders: shared(localA.replica), replicaScanIntervalMs: 100, timeoutMs: 3000,
      onSession: session => { incoming = session; accepted.resolve(session); } });
    let changeToken!: () => Promise<void>;
    const adapter = createNodeHostAdapter();
    const client = createSyncpeerCoreClient({ ...adapter, connectTls: async options => {
      const socket = await adapter.connectTls(options);
      let hello = true;
      const parser = new FrameParser((type, message) => {
        if (type !== MessageTypeValues.CLUSTER_CONFIG) return;
        const config = message as BepClusterConfig;
        changeToken = () => socket.write(encodeMessageFrame(type, ClusterConfig, { ...config,
          folders: config.folders!.map(folder => ({ ...folder, devices: folder.devices!.map(device => ({ ...device,
            encryption_password_token: new Uint8Array(folderIdentity.passwordToken.length),
          })) })),
        }, 0));
      });
      return { close: () => socket.close(), read: size => socket.read(size), peerCertificateDer: () => socket.peerCertificateDer(),
        write: async data => { if (hello) hello = false; else parser.feed(data); await socket.write(data); } };
    } });
    outgoing = await client.openSession({ ...b, host: "127.0.0.1", port: listener.port,
      expectedDeviceId: a.deviceId, discoveryMode: "direct", timeoutMs: 3000, replicaScanIntervalMs: 100, sharedFolders: shared(localB.replica) });
    incoming = await accepted.promise;
    const deadline = Date.now() + 3000;
    for (const [local, remote] of [[localA, localB], [localB, localA]]) {
      let versions = (await local.replica.snapshot()).versions;
      while (!Object.values(versions).some(version => version.info.name === remote.encrypted.name)) {
        assert.ok(Date.now() < deadline, "Locked peers must receive each other's ciphertext");
        await new Promise(resolve => setTimeout(resolve, 10));
        versions = (await local.replica.snapshot()).versions;
      }
      const [id] = Object.entries(versions).find(([, version]) => version.info.name === remote.encrypted.name)!;
      const block = remote.encrypted.blocks![0];
      assert.deepEqual(await local.replica.readBlock(id, 0, block.size, block.hash),
        await readCiphertextBlock(remote.source, remote.metadata, 0, block.size, block.hash));
    }
    await localA.replica.receive(folderIdentity, update.encrypted,
      (offset, size, token) => readCiphertextBlock(update.source, update.metadata, offset, size, token));
    const updateDeadline = Date.now() + 3000;
    while (!Object.values((await localB.replica.snapshot()).versions).some(version => version.info.name === update.encrypted.name)) {
      assert.ok(Date.now() < updateDeadline, "New ciphertext must propagate without reconnecting");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(incoming.isClosed(), false);
    assert.equal(outgoing.isClosed(), false);
    const historyBefore = (await localA.replica.snapshot()).sequence;
    await changeToken();
    const closure = await incoming.closed;
    assert.match(closure.message, /identity mismatch/);
    assert.equal((await localA.replica.snapshot()).sequence, historyBefore, "Token changes must not mutate accepted history");
  } finally {
    crypto.folderKey.fill(0);
    await outgoing?.close(); await incoming?.close(); await listener?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["plaintext", "encrypted"] as const) {
test(`two Syncpeer peers exchange ${mode} blocks over TLS without Syncthing`, { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-peers-"));
  let listener: Awaited<ReturnType<typeof listenNodePeer>> | undefined;
  let outgoing: SyncpeerSessionHandle | undefined;
  let incoming: SyncpeerSessionHandle | undefined;
  try {
    const [a, b] = await Promise.all([createTestPeerIdentity(root, "a"), createTestPeerIdentity(root, "b")]);
    const sharedFolders = [{ id: "fixture-folder", encryption: mode === "plaintext"
      ? { mode } : { mode, password: "synthetic-folder-password" } }];
    const localReplica = async (name: string, counter: string) => {
      const directory = path.join(root, name);
      await mkdir(directory);
      await writeFile(path.join(directory, `persisted-${name}.txt`), name);
      await writeFile(path.join(directory, `multi-${name}.bin`), new Uint8Array(131075).map((_, i) => i % 251));
      return createNodeFolderReplica(directory, counter);
    };
    const replicaA = await localReplica("share-a", "1");
    const replicaB = await localReplica("share-b", "2");
    await replicaA?.pause();
    let accept!: (session: SyncpeerSessionHandle) => void;
    const accepted = new Promise<SyncpeerSessionHandle>(resolve => { accept = resolve; });
    listener = await listenNodePeer({ ...a, host: "127.0.0.1", port: 0,
      expectedDeviceId: b.deviceId, deviceName: "fixture-a", sharedFolders: sharedFolders.map(folder => ({ ...folder, replica: replicaA })),
      timeoutMs: 3000, replicaScanIntervalMs: 100, onSession: accept });
    const adapter = createNodeHostAdapter();
    let repeatCluster: ((downgrade: boolean) => Promise<void>) | undefined;
    let captureIndex = false;
    let receiveIndex!: (index: BepIndex) => void;
    const incomingFrames = new FrameParser((type, message) => {
      if (type === MessageTypeValues.INDEX) receiveIndex(message as BepIndex);
    });
    const client = mode === "plaintext" ? createNodeSyncpeerClient() : createSyncpeerCoreClient({
      ...adapter,
      connectTls: async options => {
        const socket = await adapter.connectTls(options);
        let firstWrite = true;
        const sentFrames = new FrameParser((type, message) => {
          if (type === MessageTypeValues.CLUSTER_CONFIG) {
            const config = message as BepClusterConfig;
            repeatCluster = downgrade => socket.write(encodeMessageFrame(type, ClusterConfig, downgrade ? {
              ...config, folders: (config.folders ?? []).map(folder => ({ ...folder, type: 0,
                devices: (folder.devices ?? []).map(device => ({ ...device, encryption_password_token: new Uint8Array() })),
              })),
            } : { ...config }, 0));
          }
        });
        return {
          close: () => socket.close(),
          peerCertificateDer: () => socket.peerCertificateDer(),
          write: async data => {
            if (firstWrite) firstWrite = false; // The separate BEP Hello precedes framed messages.
            else sentFrames.feed(data);
            await socket.write(data);
          },
          read: async maxBytes => {
            const data = await socket.read(maxBytes);
            if (captureIndex) incomingFrames.feed(data);
            return data;
          },
        };
      },
    });
    outgoing = await client.openSession({ ...b,
      host: "127.0.0.1", port: listener.port, expectedDeviceId: a.deviceId,
      deviceName: "fixture-b", sharedFolders: sharedFolders.map(folder => ({ ...folder, replica: replicaB })), discoveryMode: "direct", timeoutMs: 3000, replicaScanIntervalMs: 100 });
    incoming = await accepted;
    assert.equal(incoming.isClosed(), false);
    assert.equal(outgoing.isClosed(), false);
    await replicaA?.resume();
    assert.equal((await incoming.remoteFs.listFolders())[0]?.id, "fixture-folder");
    assert.equal((await outgoing.remoteFs.listFolders())[0]?.id, "fixture-folder");
    await assert.rejects(incoming.remoteFs.writeFileFully("fixture-folder", ".stignore", new Uint8Array([1])), /internal|reserved/i);
    {
      const deadline = Date.now() + 3000;
      while (true) {
        const received = await Promise.all([
          readFile(path.join(root, "share-a", "persisted-share-b.txt"), "utf8").catch(() => null),
          readFile(path.join(root, "share-b", "persisted-share-a.txt"), "utf8").catch(() => null),
        ]);
        if (received[0] === "share-b" && received[1] === "share-a") break;
        assert.ok(Date.now() < deadline, "Both peers must persist the other's file");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      for (const [local, remote] of [["share-a", "share-b"], ["share-b", "share-a"]]) {
        const expected = new Uint8Array(131075).map((_, i) => i % 251);
        const deadline = Date.now() + 3000;
        while (true) {
          const actual = await readFile(path.join(root, local, `multi-${remote}.bin`)).catch(() => null);
          if (actual) { assert.deepEqual(new Uint8Array(actual), expected); break; }
          assert.ok(Date.now() < deadline, "Multi-block replica did not synchronize");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      const localEdit = new TextEncoder().encode("edited after connection");
      const beforeEdit = (await replicaA.scan()).find(file => file.name === "persisted-share-a.txt")!;
      await replicaA.edit!({ method: "write", folderId: "fixture-folder", path: beforeEdit.name,
        expectedVersion: beforeEdit.version!, modifiedMs: Date.now(),
        source: { size: localEdit.length, readRange: async (offset, size) => localEdit.slice(offset, offset + size) } });
      const updateDeadline = Date.now() + 3000;
      while (await readFile(path.join(root, "share-b", "persisted-share-a.txt"), "utf8") !== "edited after connection") {
        assert.ok(Date.now() < updateDeadline, "Local edits must synchronize without reconnecting");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await Promise.all([
        writeFile(path.join(root, "share-a", "concurrent.txt"), "edit from a"),
        writeFile(path.join(root, "share-b", "concurrent.txt"), "edit from b"),
      ]);
      const conflictDeadline = Date.now() + 4000;
      while (true) {
        const versions = await Promise.all(["share-a", "share-b"].map(async share => {
          const names = (await readdir(path.join(root, share))).filter(name => name === "concurrent.txt" || name.startsWith("concurrent.txt.sync-conflict-"));
          return Promise.all(names.map(name => readFile(path.join(root, share, name), "utf8")));
        }));
        if (versions.every(contents => contents.length === 2 && contents.includes("edit from a") && contents.includes("edit from b"))) break;
        assert.ok(Date.now() < conflictDeadline, "Concurrent edits must converge while preserving both versions");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const beforeDelete = (await replicaA.scan()).find(file => file.name === "persisted-share-a.txt")!;
      await replicaA.edit!({ method: "delete", folderId: "fixture-folder", path: beforeDelete.name,
        expectedVersion: beforeDelete.version!, modifiedMs: Date.now() });
      const deletionDeadline = Date.now() + 3000;
      while (await readFile(path.join(root, "share-b", "persisted-share-a.txt")).then(() => true, error => {
        if (error.code === "ENOENT") return false;
        throw error;
      })) {
        assert.ok(Date.now() < deletionDeadline, "Remote deletion must propagate");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const versionStorage = await createNodeFolderSyncStorage(path.join(root, "share-b"));
      const versions = await versionStorage.listVersions("persisted-share-a.txt");
      assert.ok(versions.length > 0, "Deletion must preserve an archived version");
      const contents = await Promise.all(versions.map(version => readFile(path.join(root, "share-b", version.archivePath), "utf8")));
      assert.ok(contents.includes("edited after connection"));
      await versionStorage.restoreVersion(versions[contents.indexOf("edited after connection")].archivePath);
      const restoreDeadline = Date.now() + 3000;
      while (await readFile(path.join(root, "share-a", "persisted-share-a.txt"), "utf8").catch(() => null) !== "edited after connection") {
        assert.ok(Date.now() < restoreDeadline, "Restored versions must synchronize to the other peer");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await replicaA!.pause();
      await writeFile(path.join(root, "share-a", "paused-local.txt"), "local while paused");
      await writeFile(path.join(root, "share-b", "paused-remote.txt"), "remote while paused");
      await new Promise(resolve => setTimeout(resolve, 350));
      await assert.rejects(readFile(path.join(root, "share-b", "paused-local.txt")), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(root, "share-a", "paused-remote.txt")), { code: "ENOENT" });
      assert.equal(incoming.isClosed(), false, "Pausing a folder must not close the peer connection");
      await replicaA!.resume();
      const resumeDeadline = Date.now() + 3000;
      while (true) {
        const values = await Promise.all([
          readFile(path.join(root, "share-b", "paused-local.txt"), "utf8").catch(() => null),
          readFile(path.join(root, "share-a", "paused-remote.txt"), "utf8").catch(() => null),
        ]);
        if (values[0] === "local while paused" && values[1] === "remote while paused") break;
        assert.ok(Date.now() < resumeDeadline, "Resuming must reconcile changes in both directions");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const fromA = new TextEncoder().encode("created by peer A");
    const fromB = new TextEncoder().encode("created by peer B");
    const publication = { waitForRemote: true, signal: AbortSignal.timeout(3000) };
    await incoming.remoteFs.writeFileFully("fixture-folder", "from-a.txt", fromA, publication);
    await outgoing.remoteFs.writeFileFully("fixture-folder", "from-b.txt", fromB, publication);
    {
      assert.deepEqual(new Uint8Array(await readFile(path.join(root, "share-b", "from-a.txt"))), fromA);
      assert.deepEqual(new Uint8Array(await readFile(path.join(root, "share-a", "from-b.txt"))), fromB);
    }
    const waitForFile = async (session: SyncpeerSessionHandle, name: string) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await session.remoteFs.listFiles("fixture-folder")).some(file => file.path === name)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("Peer did not receive the published index.");
    };
    await waitForFile(outgoing, "from-a.txt");
    await waitForFile(incoming, "from-b.txt");
    assert.deepEqual(await outgoing.remoteFs.readFileFully("fixture-folder", "from-a.txt"), fromA);
    assert.deepEqual(await incoming.remoteFs.readFileFully("fixture-folder", "from-b.txt"), fromB);
    if (mode === "encrypted") {
      assert.ok(repeatCluster);
      captureIndex = true;
      for (const downgrade of [false, true]) {
        const repeatedIndex = new Promise<BepIndex>(resolve => { receiveIndex = resolve; });
        await repeatCluster(downgrade);
        const index = await Promise.race([repeatedIndex, new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Missing repeated encrypted index")), 3000);
          timer.unref();
        })]);
        assert.ok(index.files.length >= 2);
        assert.ok(index.files.every(file => file.encrypted?.length && !["from-a.txt", "from-b.txt"].includes(file.name)),
          "Repeated or downgraded cluster configuration must not publish plaintext metadata to an encrypted peer");
      }
    }
    await outgoing.close();
    await incoming.closed;
    assert.equal(incoming.isClosed(), true);
    await listener.close();
    listener = undefined;

    if (mode === "plaintext") {
      const connectionArgs = (name: string, remoteId: string) => ["packages/cli/dist/main.js",
        "--cert", path.join(root, `${name}.pem`), "--key", path.join(root, `${name}.key`), "--remote-id", remoteId, "--discovery-mode", "direct"];
      const server = spawn(process.execPath, [...connectionArgs("a", b.deviceId),
        "peer-folder", "fixture-folder", path.join(root, "share-a"), "--listen", "--listen-port", "0", "--scan-interval", "100"],
      { stdio: ["ignore", "pipe", "pipe"] });
      let client: ReturnType<typeof spawn> | undefined;
      const serverExit = new Promise(resolve => server.once("exit", resolve));
      server.stderr.resume();
      try {
        const port = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Standalone CLI listener did not start")), 4000);
          let output = "";
          server.stdout.on("data", bytes => {
            output += String(bytes);
            const match = output.match(/Peer listener ready: (\d+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
          });
          server.once("error", error => { clearTimeout(timer); reject(error); });
          server.once("exit", () => { clearTimeout(timer); reject(new Error("Standalone CLI listener exited")); });
        });
        client = spawn(process.execPath, [...connectionArgs("b", a.deviceId), "--port", port,
          "peer-folder", "fixture-folder", path.join(root, "share-b"), "--scan-interval", "100"], { stdio: "ignore" });
        await writeFile(path.join(root, "share-a", "cli-file.txt"), "from a standalone process");
        const deadline = Date.now() + 4000;
        while (await readFile(path.join(root, "share-b", "cli-file.txt"), "utf8").catch(() => null) !== "from a standalone process") {
          assert.ok(Date.now() < deadline, "Standalone processes did not synchronize");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } finally {
        const clientExit = client && client.exitCode === null ? new Promise(resolve => client!.once("exit", resolve)) : Promise.resolve();
        client?.kill("SIGTERM"); server.kill("SIGTERM");
        await Promise.all([serverExit, clientExit]);
      }
    }

    let rejection!: (error: unknown) => void;
    const rejected = new Promise<unknown>(resolve => { rejection = resolve; });
    listener = await listenNodePeer({ ...a, host: "127.0.0.1", port: 0,
      expectedDeviceId: b.deviceId, deviceName: "fixture-a", sharedFolders,
      timeoutMs: 1000, onSession: () => assert.fail("Unapproved identity was accepted"), onError: rejection });
    await assert.rejects(createNodeSyncpeerClient().openSession({ ...a,
      host: "127.0.0.1", port: listener.port, expectedDeviceId: a.deviceId,
      deviceName: "unapproved-fixture", discoveryMode: "direct", timeoutMs: 1000 }));
    assert.match(String(await rejected), /device ID mismatch/);
  } finally {
    await outgoing?.close();
    await incoming?.close();
    await listener?.close();
    await rm(root, { recursive: true, force: true });
  }
});
}
