import { sha256 } from "@noble/hashes/sha2.js";
import { createNativeFilesystem, createEncryptedDownloadSink, deriveUntrustedFolderCrypto, loadEncryptedDiskMetadata, readEncryptedDiskRange,
  readEncryptedNamespace, writeEncryptedDiskFile, saveEncryptedReplicaIndex, loadEncryptedReplicaIndex,
  loadCiphertextDiskMetadata, readCiphertextBlock, receiveCiphertextFile,
  createCiphertextIndex, prepareCiphertextUpdate, completeCiphertextUpdate, saveCiphertextIndex, loadCiphertextIndex, createCiphertextReplica, openCiphertextView,
  createCredentialVault, createCredentialVaultStorage, type RememberedUnlockSecretStore,
  createEncryptedReplicaStorage, createFolderReplica, createReplicaController, createFolderRegistry, createReplicaFileSource,
  openReplicaWritableFile, type NativeFilesystemRequest } from "@syncpeer/core/filesystem";

/** Runs the real core library in the Android WebView against the native byte-storage port. */
export async function runFilesystemConformance(request: (request: NativeFilesystemRequest) => Promise<unknown>, root: string,
  rememberedSecret: RememberedUnlockSecretStore) {
  const folder = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const bytes = new Uint8Array(131075).map((_, i) => i % 251);
  const fileInfo = { name: "private-fixture/nested-file", type: 0, size: bytes.length, block_size: 131072,
    version: { counters: [{ id: "42", value: "1" }] },
    blocks: [0, 131072].map(offset => {
      const chunk = bytes.slice(offset, offset + 131072);
      return { offset, size: chunk.length, hash: sha256(chunk) };
    }),
  };
  const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));
  const source = { size: bytes.length, readRange: async (offset: number, size: number) => bytes.slice(offset, offset + size) };
  const storage = await createNativeFilesystem(request, root);
  try {
    await storage.initializeReplica();
    const vaultOptions = { profileId: "synthetic-native-profile", randomBytes, rememberedSecret,
      storage: createCredentialVaultStorage(storage, { withLock: storage.withLock, checkHealth: storage.checkHealth }),
      revokeAccess: async () => {} };
    const vault = createCredentialVault(vaultOptions);
    const createdVault = await vault.create("synthetic-native-master");
    if (!createdVault.remembered) throw new Error("Native unlock secret was not remembered.");
    await vault.setDefaultPassword("synthetic-folder-password");
    await vault.addFolder("fixture-vault-folder");
    await vault.lock();
    const restartedVault = createCredentialVault(vaultOptions);
    if ((await restartedVault.initialize()).phase !== "locked") throw new Error("Native remember bypassed manual lock.");
    await restartedVault.unlock("synthetic-native-master");
    const automaticVault = createCredentialVault(vaultOptions);
    if ((await automaticVault.initialize()).phase !== "unlocked" ||
      await automaticVault.folderPassword("fixture-vault-folder") !== "synthetic-folder-password") {
      throw new Error("Native vault did not reopen with its protected unlock secret.");
    }
    await automaticVault.forgetRememberedSecret();
    await Promise.all([vault.close(), restartedVault.close(), automaticVault.close()]);
    const competing = await createNativeFilesystem(request, root);
    try {
      await storage.withLock(async () => {
        try {
          await competing.withLock(async () => { throw new Error("Competing root unexpectedly locked"); });
          throw new Error("Competing lock unexpectedly succeeded");
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("busy")) throw error;
        }
      });
      await competing.withLock(competing.checkHealth);
    } finally { await competing.close(); }
    const { sink, encrypted } = await createEncryptedDownloadSink({ fileInfo, folderKey: folder.folderKey, randomBytes,
      createSink: (info, size) => storage.createSink(info.name, size) });
    try {
      await sink.begin({ folderId: "fixture-folder", path: fileInfo.name, sizeBytes: bytes.length, encrypted: false });
      await sink.write(0, bytes.subarray(0, 7));
      await sink.write(7, bytes.subarray(7));
      await sink.commit();
    } catch (error) { await sink.abort(error); throw error; }
    const namespace = await readEncryptedNamespace(storage, folder.folderKey);
    if (namespace.get(fileInfo.name)?.fileInfo.size !== bytes.length) throw new Error("Encrypted namespace metadata mismatch.");
    const stored = (await storage.listEntries()).find(entry => entry.path === encrypted.name);
    if (!stored) throw new Error("Encrypted native file was not committed.");
    const ciphertextSource = { size: stored.size,
      readRange: (offset: number, size: number) => storage.readRange(encrypted.name, offset, size) };
    const opaque = await loadCiphertextDiskMetadata(ciphertextSource, encrypted.name);
    const lockedIndexPath = ".syncpeer-locked-index-check";
    const lockedIdentity = { folderId: folder.folderId, passwordToken: folder.passwordToken };
    await storage.makeDirectory(".syncpeer-locked-fixture");
    const lockedRoot = `${root}/.syncpeer-locked-fixture`;
    const lockedStorage = await createNativeFilesystem(request, lockedRoot);
    try {
      await lockedStorage.initializeReplica();
      const replica = createCiphertextReplica(lockedStorage, { identity: lockedIdentity,
        withLock: lockedStorage.withLock, checkHealth: lockedStorage.checkHealth });
      try {
        await replica.receive(lockedIdentity, opaque.encrypted, async () => { throw new Error("synthetic interruption"); });
        throw new Error("Interrupted locked replica unexpectedly completed.");
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "synthetic interruption") throw error;
      }
      const pending = await replica.snapshot();
      if (!pending.pending || Object.keys(pending.versions).length) throw new Error("Locked replica lost pending history.");
    } finally { await lockedStorage.close(); }
    const lockedReopened = await createNativeFilesystem(request, lockedRoot);
    try {
      const replica = createCiphertextReplica(lockedReopened, { identity: lockedIdentity,
        withLock: lockedReopened.withLock, checkHealth: lockedReopened.checkHealth });
      const received = await replica.receive(lockedIdentity, opaque.encrypted,
        (offset, size, token) => readCiphertextBlock(ciphertextSource, opaque, offset, size, token));
      const id = Object.keys(received.versions)[0];
      for (const block of opaque.encrypted.blocks ?? []) {
        const original = await readCiphertextBlock(ciphertextSource, opaque, Number(block.offset), block.size, block.hash);
        const served = await replica.readBlock(id, Number(block.offset), block.size, block.hash);
        if (served.length !== original.length || served.some((byte, index) => byte !== original[index])) {
          throw new Error("Reopened locked replica changed ciphertext.");
        }
      }
      const view = await openCiphertextView(replica, folder.folderKey);
      try {
        if (!view.list().has(fileInfo.name)) throw new Error("Unlocked native view lost the authenticated filename.");
        const content = await view.readRange(fileInfo.name, 131070, 5);
        if (content.length !== 5 || content.some((byte, index) => byte !== bytes[131070 + index])) {
          throw new Error("Unlocked native view returned incorrect plaintext.");
        }
      } finally { view.close(); }
    } finally { await lockedReopened.close(); }
    const journal = prepareCiphertextUpdate(createCiphertextIndex(lockedIdentity), lockedIdentity, opaque.encrypted);
    await storage.withLock(async () => {
      await saveCiphertextIndex(journal, size => storage.createSink(lockedIndexPath, size));
      await storage.flushChanges([lockedIndexPath]);
    });
    const copied = await receiveCiphertextFile({ encrypted: opaque.encrypted,
      requestBlock: (offset, size, token) => readCiphertextBlock(ciphertextSource, opaque, offset, size, token),
      createSink: (_info, size) => storage.createSink(".syncpeer-ciphertext-check", size) });
    if (copied.verification !== "pending-unlock") throw new Error("Keyless reception claimed plaintext authentication.");
    const copiedStat = await storage.stat(".syncpeer-ciphertext-check");
    if (!copiedStat) throw new Error("Keyless native copy is missing.");
    const copiedMetadata = await loadCiphertextDiskMetadata({ size: copiedStat.size,
      readRange: (offset, size) => storage.readRange(".syncpeer-ciphertext-check", offset, size) }, encrypted.name);
    if (opaque.dataSize !== copiedMetadata.dataSize || JSON.stringify(opaque.encrypted) !== JSON.stringify(copiedMetadata.encrypted)) {
      throw new Error("Keyless reception changed encrypted metadata.");
    }
    // The outer protobuf trailer may canonicalize defaults; encrypted metadata and body must not change.
    for (let offset = 0; offset < opaque.dataSize; offset += 131072) {
      const size = Math.min(131072, opaque.dataSize - offset);
      const original = await ciphertextSource.readRange(offset, size);
      const copy = await storage.readRange(".syncpeer-ciphertext-check", offset, size);
      if (copy.length !== original.length || copy.some((value, index) => value !== original[index])) {
        throw new Error("Keyless native reception changed ciphertext.");
      }
    }
    if ((await storage.listEntries()).some(entry => entry.path.includes("private-fixture"))) throw new Error("Plaintext filename leaked to storage.");
    const indexPath = ".syncpeer-replica-index";
    await saveEncryptedReplicaIndex({ index: { format: 1, sequence: 1,
      files: { [fileInfo.name]: { revision: stored.revision, info: fileInfo } }, pending: fileInfo },
      folderKey: folder.folderKey, randomBytes, createSink: (_info, size) => storage.createSink(indexPath, size) });
    const controller = new AbortController();
    try {
      await writeEncryptedDiskFile({ source, fileInfo, folderKey: folder.folderKey, randomBytes, signal: controller.signal,
        createSink: async (info, size) => {
          const sink = await storage.createSink(info.name, size);
          return { ...sink, write: async (offset, chunk) => { await sink.write(offset, chunk); controller.abort(); } };
        },
      });
      throw new Error("Cancelled encrypted replacement unexpectedly committed.");
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    }
    await storage.close();
    const reopened = await createNativeFilesystem(request, root);
    try {
      await reopened.withLock(async () => {
        const stat = await reopened.stat(lockedIndexPath);
        if (!stat) throw new Error("Locked native journal missing after reopen.");
        const pending = await loadCiphertextIndex({ size: stat.size,
          readRange: (offset, size) => reopened.readRange(lockedIndexPath, offset, size) }, lockedIdentity);
        if (pending.sequence !== 0 || !pending.pending || Object.keys(pending.versions).length) {
          throw new Error("Locked native journal advertised uncommitted content.");
        }
        const committed = completeCiphertextUpdate(pending, pending.pending.id, copiedStat.revision);
        await saveCiphertextIndex(committed, size => reopened.createSink(lockedIndexPath, size));
        await reopened.flushChanges([lockedIndexPath]);
        const committedStat = await reopened.stat(lockedIndexPath);
        const recovered = await loadCiphertextIndex({ size: committedStat!.size,
          readRange: (offset, size) => reopened.readRange(lockedIndexPath, offset, size) }, lockedIdentity);
        if (recovered.sequence !== 1 || Object.values(recovered.versions)[0]?.verification !== "pending-unlock") {
          throw new Error("Locked native generation did not survive publication.");
        }
      });
      const indexStat = await reopened.stat(indexPath);
      if (!indexStat || indexStat.type !== "file") throw new Error("Encrypted native index missing after reopen.");
      const index = await loadEncryptedReplicaIndex({ size: indexStat.size,
        readRange: (offset, size) => reopened.readRange(indexPath, offset, size) }, folder.folderKey);
      if (index.pending?.name !== fileInfo.name || index.files[fileInfo.name]?.info.size !== bytes.length) {
        throw new Error("Encrypted native index journal did not survive reopening.");
      }
      const disk = { size: stored.size, readRange: (offset: number, size: number) => reopened.readRange(encrypted.name, offset, size) };
      const metadata = await loadEncryptedDiskMetadata(disk, encrypted.name, folder.folderKey);
      try {
        const read = await readEncryptedDiskRange(disk, metadata, 0, bytes.length);
        if (read.length !== bytes.length || read.some((value, i) => value !== bytes[i])) throw new Error("Reopened native encrypted file checksum mismatch.");
      } finally { metadata.fileKey.fill(0); }
      const archives: Array<{ path: string; source: string }> = [];
      const replica = createReplicaController(createFolderReplica(createEncryptedReplicaStorage(reopened, {
        folderKey: folder.folderKey, randomBytes,
        withLock: reopened.withLock,
        checkHealth: reopened.checkHealth,
        archive: async path => {
          const target = `.stversions/fixture-${archives.length}`;
          await reopened.copy(path, target); archives.push({ path: target, source: path });
        },
      }), "1", sha256));
      const registry = createFolderRegistry({
        load: async () => [{ id: "fixture-folder", label: "Fixture", storageId: "fixture-root" }],
        save: async () => {}, open: async () => ({ replica, close: reopened.close }),
      });
      await registry.initialize();
      try {
      await registry.open("fixture-folder");
      if (registry.getReplica("fixture-folder") !== replica) throw new Error("Registry did not expose the native replica.");
      await registry.pause("fixture-folder");
      if (registry.getState()[0].phase !== "paused") throw new Error("Registry pause status missing.");
      await registry.resume("fixture-folder");
      await replica.receive!("fixture-folder", [{ name: "empty-received", type: 0, size: 0,
        blocks: [{ offset: 0, size: 0, hash: sha256(new Uint8Array()) }],
        version: { counters: [{ id: "2", value: "1" }] } }],
      async () => { throw new Error("Empty encrypted replica must not request content"); });
      if (!(await replica.scan()).some(info => info.name === "empty-received" && Number(info.size) === 0 && !info.deleted)) {
        throw new Error("Empty encrypted replica did not survive scanning.");
      }
      // A protocol block is larger than a native byte read; core must bridge that boundary.
      const changed = new Uint8Array(256 * 1024).map((_, index) => index % 251);
      const local = await replica.edit!({ method: "write", folderId: "fixture-folder", path: "local-edit", modifiedMs: 1000,
        expectedVersion: null, source: { size: changed.length,
          readRange: async (offset, size) => changed.slice(offset, offset + size) } });
      if (String(local.version?.counters?.[0]?.value) !== "1") throw new Error("Local edit did not publish causal history.");
      const localSource = await createReplicaFileSource(replica, local.name);
      const localBytes = await localSource.readRange(131070, 5);
      if (localBytes.length !== 5 || localBytes.some((value, index) => value !== changed[131070 + index])) {
        throw new Error("Local encrypted edit could not be served.");
      }
      const writable = await openReplicaWritableFile(replica, {
        folderId: "fixture-folder", path: local.name, open: "existing", scratch: memoryScratch(), modifiedMs: 1500,
      });
      await writable.write(1, new Uint8Array([99, 98, 97]));
      await writable.truncate(6);
      const writableInfo = await writable.commit();
      const writableSource = await createReplicaFileSource(replica, writableInfo.name);
      const writableBytes = await writableSource.readRange(0, 6);
      if (writableBytes.length !== 6 || writableBytes.some((value, index) => value !== [0, 99, 98, 97, 4, 5][index])) {
        throw new Error("Native encrypted replica writable handle published incorrect bytes.");
      }
      const directory = { name: "replica-directory", type: 1, size: 0, version: { counters: [{ id: "2", value: "1" }] } };
      const update = { name: "replica-directory/replica-file", type: 0, size: changed.length,
        blocks: [{ offset: 0, size: changed.length, hash: sha256(changed) }], version: { counters: [{ id: "2", value: "1" }] } };
      await replica.receive!("fixture-folder", [directory, update], async () => changed);
      const served = await replica.readBlock(update.name, 0, changed.length);
      if (served.length !== changed.length || served.some((value, i) => value !== changed[i])) throw new Error("Native encrypted replica served incorrect bytes.");
      await replica.edit!({ method: "delete", folderId: "fixture-folder", path: update.name,
        expectedVersion: update.version, modifiedMs: 2000 });
      const deletedDirectory = await replica.edit!({ method: "delete", folderId: "fixture-folder", path: directory.name,
        expectedVersion: directory.version, modifiedMs: 2000 });
      const recreatedDirectory = await replica.edit!({ method: "mkdir", folderId: "fixture-folder", path: directory.name,
        expectedVersion: deletedDirectory.version!, modifiedMs: 3000 });
      if (recreatedDirectory.deleted || recreatedDirectory.type !== 1) throw new Error("Local directory recreation failed.");
      if (!(await replica.scan()).find(info => info.name === update.name)?.deleted) {
        throw new Error("Native encrypted replica did not archive and retain the deletion.");
      }
      let deletedArchive: { path: string; source: string } | undefined;
      for (const archive of archives) {
        const archivedStat = await reopened.stat(archive.path);
        if (!archivedStat) throw new Error("Native encrypted archive missing.");
        const archivedSource = { size: archivedStat.size,
          readRange: (offset: number, size: number) => reopened.readRange(archive.path, offset, size) };
        const archivedMetadata = await loadEncryptedDiskMetadata(archivedSource, archive.source, folder.folderKey);
        try {
          if (archivedMetadata.fileInfo.name === update.name) deletedArchive = archive;
        } finally { archivedMetadata.fileKey.fill(0); }
      }
      if (!deletedArchive) throw new Error("Native encrypted deletion archive is missing.");
      const archivedStat = await reopened.stat(deletedArchive.path);
      const archivedSource = { size: archivedStat!.size,
        readRange: (offset: number, size: number) => reopened.readRange(deletedArchive.path, offset, size) };
      const archivedMetadata = await loadEncryptedDiskMetadata(archivedSource, deletedArchive.source, folder.folderKey);
      try {
        const restored = await readEncryptedDiskRange(archivedSource, archivedMetadata, 0, changed.length);
        if (restored.length !== changed.length || restored.some((value, i) => value !== changed[i])) {
          throw new Error("Native encrypted archive cannot recover the deleted contents.");
        }
      } finally { archivedMetadata.fileKey.fill(0); }
      await reopened.remove(".syncpeer-folder-marker", false);
      try {
        await replica.scan();
        throw new Error("Replica scanned storage after its marker disappeared");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("marker unavailable")) throw error;
      }
      if (registry.getState()[0].phase !== "error") throw new Error("Native storage failure missing from registry status.");
      } finally { await registry.close(); }
      if (registry.getState()[0].phase !== "closed") throw new Error("Registry shutdown did not close native storage.");
    } finally { await reopened.close(); }
    return { bytes: bytes.length, encrypted: true, cancellationPreservedOriginal: true, reopenVerified: true, replicaLifecycleVerified: true };
  } finally { await storage.close(); folder.folderKey.fill(0); }
}

function memoryScratch() {
  let bytes = new Uint8Array();
  return {
    size: async () => bytes.length,
    readRange: async (offset: number, size: number) => bytes.slice(offset, Math.min(bytes.length, offset + size)),
    write: async (offset: number, chunk: Uint8Array) => {
      const next = new Uint8Array(Math.max(bytes.length, offset + chunk.length));
      next.set(bytes);
      next.set(chunk, offset);
      bytes = next;
    },
    truncate: async (size: number) => {
      const next = new Uint8Array(size);
      next.set(bytes.subarray(0, size));
      bytes = next;
    },
    close: async () => {},
  };
}
