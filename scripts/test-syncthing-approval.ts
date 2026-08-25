import assert from "node:assert/strict";
import {
  approvePendingDevice,
  listPendingDevices,
  waitForPendingDeviceChange,
  type SyncthingApiCall,
} from "./lan-test/approval.ts";

const main = async (): Promise<void> => {
  const calls: SyncthingApiCall[] = [];
  const request = async <T>(call: SyncthingApiCall): Promise<T> => {
    calls.push(call);
    if (call.pathname === "/rest/cluster/pending/devices") {
      return {
        "CLIENT-ID": {
          time: "2026-08-25T00:00:00Z",
          name: "Syncpeer client",
          address: "relay://example.test",
        },
      } as T;
    }
    if (call.pathname.startsWith("/rest/events?")) {
      return [{ id: 42, type: "PendingDevicesChanged" }] as T;
    }
    if (call.pathname === "/rest/config/defaults/device") {
      return { addresses: ["dynamic"], compression: "metadata" } as T;
    }
    if (call.pathname === "/rest/config/folders/syncpeer-test") {
      return {
        id: "syncpeer-test",
        devices: [{ deviceID: "SERVER-ID" }],
      } as T;
    }
    return undefined as T;
  };

  assert.deepEqual(await listPendingDevices(request), [{
    deviceId: "CLIENT-ID",
    name: "Syncpeer client",
    address: "relay://example.test",
  }]);

  assert.equal(await waitForPendingDeviceChange(12, request), 42);

  await approvePendingDevice({
    deviceId: "CLIENT-ID",
    deviceName: "Syncpeer development client",
    folderId: "syncpeer-test",
  }, request);

  assert.deepEqual(calls.slice(2), [
    { pathname: "/rest/config/defaults/device" },
    {
      pathname: "/rest/config/devices",
      method: "POST",
      body: {
        addresses: ["dynamic"],
        compression: "metadata",
        deviceID: "CLIENT-ID",
        name: "Syncpeer development client",
        untrusted: false,
      },
    },
    { pathname: "/rest/config/folders/syncpeer-test" },
    {
      pathname: "/rest/config/folders/syncpeer-test",
      method: "PUT",
      body: {
        id: "syncpeer-test",
        devices: [
          { deviceID: "SERVER-ID" },
          {
            deviceID: "CLIENT-ID",
            introducedBy: "",
            encryptionPassword: "",
          },
        ],
      },
    },
  ]);

  console.log("Syncthing pending-device approval test passed.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
