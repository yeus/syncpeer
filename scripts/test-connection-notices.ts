import assert from "node:assert/strict";
import test from "node:test";
import {
  folderRootEmptyNotice,
  localDiscoveryUnavailableNotice,
} from "../packages/app/src/app/connectionNotices.ts";
import { createTauriAdapters } from "../packages/app/src/lib/tauriAdapters.ts";

test("explains an empty folder list on a healthy connection", () => {
  assert.equal(
    folderRootEmptyNotice(true, 0),
    "Connected, but the remote device is not sharing any folders with this device. Share a folder with this device in the remote Syncthing settings.",
  );
  assert.equal(folderRootEmptyNotice(false, 0), "Connect to browse folders.");
  assert.equal(folderRootEmptyNotice(true, 1), null);
});

test("explains local discovery port contention without implying connection failure", () => {
  assert.equal(
    localDiscoveryUnavailableNotice(
      new Error("Local discovery sockets unavailable (udp4 bind failed: Address already in use (os error 98))."),
    ),
    "Local discovery is unavailable because another application is already using its network port. This often happens when another Syncthing instance is running on this computer. Automatic, global, direct, and relay connections can still work.",
  );
});

test("does not reclassify unrelated discovery failures", () => {
  assert.equal(localDiscoveryUnavailableNotice(new Error("Network request failed")), null);
});

test("serializes overlapping native local discovery calls", async () => {
  let discoveryCalls = 0;
  let releaseFirstDiscovery = () => {};
  const firstDiscovery = new Promise<void>((resolve) => {
    releaseFirstDiscovery = resolve;
  });
  const scope = globalThis as typeof globalThis & {
    __TAURI__?: {
      core?: {
        invoke?: <T>(command: string) => Promise<T>;
      };
    };
  };
  const previousTauri = scope.__TAURI__;
  scope.__TAURI__ = {
    core: {
      invoke: async <T>(command: string): Promise<T> => {
        if (command === "syncpeer_android_enable_multicast_lock") return false as T;
        assert.equal(command, "syncpeer_discovery_local");
        discoveryCalls += 1;
        if (discoveryCalls === 1) await firstDiscovery;
        return {
          candidates: [],
          diagnostics: {
            socketsBound: 0,
            syncpeerLanActive: true,
          },
        } as T;
      },
    },
  };

  try {
    const discover = createTauriAdapters().hostAdapter.discoverLocalCandidates;
    assert.ok(discover);
    const first = discover({ expectedDeviceId: "FIRST", timeoutMs: 1200 });
    await Promise.resolve();
    const second = discover({ expectedDeviceId: "SECOND", timeoutMs: 1400 });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(discoveryCalls, 1);
    releaseFirstDiscovery();
    await Promise.all([first, second]);
    assert.equal(discoveryCalls, 2);
  } finally {
    scope.__TAURI__ = previousTauri;
  }
});
