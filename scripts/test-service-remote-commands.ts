import assert from "node:assert/strict";
import test from "node:test";
import { executeServiceRemoteCommand } from "../packages/core/src/sync/serviceRemoteCommands.ts";

const session = () => {
  const requested: string[] = [];
  const api = {
    session: {
      remoteDeviceId: "synthetic-peer",
      connectedVia: "synthetic-tcp",
      transportKind: "direct-tcp" as const,
      remoteFs: {
        listFolders: async () => [{ id: "folder", label: "Synthetic", readOnly: true }],
        getRemoteDeviceInfo: () => ({ id: "synthetic-peer", deviceName: "peer", clientName: "test", clientVersion: "1" }),
        listFolderSyncStates: () => [{ folderId: "folder", remoteIndexId: "1", remoteMaxSequence: "2", indexReceived: true }],
        requestFolderIndex: async (id: string) => { requested.push(id); },
        waitForFolderIndex: async () => true,
        readDir: async (_id: string, path: string) => Array.from({ length: 3 }, (_, i) => ({
          name: String(i), path: path + "/" + i, type: "file" as const, size: 5, modifiedMs: 0,
        })),
      },
    },
    requests: () => requested,
  };
  return api;
};

test("service-owned remote metadata can be browsed without another socket", async () => {
  const owner = session();
  const overview = await executeServiceRemoteCommand(owner.session, { operation: "overview" });
  assert.equal(overview.folders[0].id, "folder");
  assert.equal(overview.device?.id, "synthetic-peer");
  const directory = await executeServiceRemoteCommand(owner.session, {
    operation: "readDir", folderId: "folder", path: "", offset: 1, limit: 1,
  });
  assert.deepEqual(directory.entries.map(e => e.name), ["1"]);
  assert.equal(directory.nextOffset, 2);
  await executeServiceRemoteCommand(owner.session, { operation: "requestFolderIndex", folderId: "folder" });
  assert.deepEqual(owner.requests(), ["folder"]);
});

test("service browsing bounds IPC and rejects malformed paths", async () => {
  const owner = session();
  await assert.rejects(executeServiceRemoteCommand(owner.session, {
    operation: "readDir", folderId: "folder", path: "../secret",
  }), /path/i);
  await assert.rejects(executeServiceRemoteCommand(owner.session, {
    operation: "readDir", folderId: "folder", path: "", limit: 10000,
  }), /limit/i);
});

test("remote directory block digests retain bytes across the Android JSON boundary", async () => {
  const owner = session();
  owner.session.remoteFs.readDir = async () => [{
    name: "file", path: "file", type: "file", size: 3, modifiedMs: 0,
    blocks: [{ offset: 0, size: 3, hash: new Uint8Array([3, 4, 5]) }],
  }] as never;
  const page = await executeServiceRemoteCommand(owner.session, {
    operation: "readDir", folderId: "folder", path: "", offset: 0, limit: 4,
  });
  const json = JSON.parse(JSON.stringify(page));
  assert.deepEqual(json.entries[0].blocks[0].hash, [3, 4, 5]);
});
test("Android remote directory pages shrink before exceeding IPC size", async () => {
  const owner = session();
  const blocks = Array.from({ length: 80 }, (_, i) => ({
    offset: i * 1024, size: 1024, hash: new Uint8Array(32).fill(i),
  }));
  owner.session.remoteFs.readDir = async () => Array.from({ length: 128 }, (_, i) => ({
    name: "file" + i, path: "file" + i, type: "file" as const, size: 80 * 1024,
    modifiedMs: 0, blocks,
  }));
  let offset = 0, count = 0, pages = 0;
  do {
    const result = await executeServiceRemoteCommand(owner.session, {
      operation: "readDir", folderId: "folder", path: "", offset, limit: 128,
    });
    assert.ok(JSON.stringify(result).length <= 512 * 1024, "Page exceeds service IPC bound.");
    count += result.entries.length;
    pages++;
    if (result.nextOffset === null) break;
    assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  } while (pages < 10);
  assert.equal(count, 128);
  assert.ok(pages > 1);
});


test("service forwards focused folder updates used by later metadata reads", async () => {
  const owner = session();
  const focused: Array<string | null> = [];
  owner.session.remoteFs.setFocusedFolder = (folderId: string | null) => { focused.push(folderId); };
  const result = await executeServiceRemoteCommand(owner.session, {
    operation: "setFocusedFolder", folderId: "folder",
  });
  assert.deepEqual(result, { focused: "folder" });
  await executeServiceRemoteCommand(owner.session, { operation: "setFocusedFolder", folderId: null });
  assert.deepEqual(focused, ["folder", null]);
  await assert.rejects(executeServiceRemoteCommand(owner.session, {
    operation: "setFocusedFolder", folderId: 7,
  }), /focused/i);
});
