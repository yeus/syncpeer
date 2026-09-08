import assert from "node:assert/strict";

export function memoryReplicaStorage() {
  const files = new Map<string, { bytes: Uint8Array; revision: string; type: "file" | "directory" }>();
  let revision = 0;
  const entry = (path: string) => {
    const file = files.get(path);
    return file ? { path, size: file.bytes.length, revision: file.revision, type: file.type, modifiedMs: 0 } : null;
  };
  const storage = {
    stat: async (path: string) => entry(path),
    listEntries: async () => [...files.keys()].map(path => entry(path)!),
    listDirectory: async (parent: string) => [...files.keys()]
      .filter(path => path.startsWith(parent ? parent + "/" : "") && !path.slice(parent ? parent.length + 1 : 0).includes("/"))
      .map(path => entry(path)!),
    readRange: async (path: string, offset: number, size: number) => {
      assert.ok(size <= 131072, "Native byte reads stay bounded even for large protocol blocks");
      return files.get(path)!.bytes.slice(offset, offset + size);
    },
    createSink: async (path: string, size: number) => {
      const bytes = new Uint8Array(size);
      return { write: async (offset: number, chunk: Uint8Array) => { bytes.set(chunk, offset); },
        commit: async () => { files.set(path, { bytes, revision: String(++revision), type: "file" }); }, abort: async () => {} };
    },
    makeDirectory: async (path: string) => { files.set(path, { bytes: new Uint8Array(), revision: String(++revision), type: "directory" }); },
    remove: async (path: string) => { files.delete(path); },
    flushChanges: async () => {},
  };
  return { files, storage };
}

export function memoryDocumentStorage() {
  const roots = new Map<string, ReturnType<typeof memoryReplicaStorage>>();
  const openStorage = async (id: string) => {
    if (!roots.has(id)) roots.set(id, memoryReplicaStorage());
    const fixture = roots.get(id)!;
    return { ...fixture.storage, initializeReplica: async () => {}, checkHealth: async () => {}, close: async () => {},
      withLock: async <T>(fn: () => Promise<T>) => fn(),
      copy: async (source: string, target: string) => {
        const bytes = fixture.files.get(source)!.bytes.slice();
        const sink = await fixture.storage.createSink(target, bytes.length);
        await sink.write(0, bytes); await sink.commit();
      } };
  };
  return { roots, openStorage };
}
