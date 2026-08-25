import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  createLanFixture,
  generateSyncthingIdentity,
} from "./lan-test/syncthing.ts";
import { sameDeviceId } from "../packages/core/src/ui/helpers.ts";

const main = async (): Promise<void> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-approval-"));
  let fixture: Awaited<ReturnType<typeof createLanFixture>> | null = null;
  try {
    const client = generateSyncthingIdentity(path.join(root, "client"));
    fixture = await createLanFixture({
      root: path.join(root, "server"),
      serverHost: "relay-only",
      mode: "relay",
    });
    await fixture.approveDevice({ deviceId: client.deviceId });

    const headers = { "X-API-Key": fixture.apiKey };
    const deviceResponse = await fetch(
      fixture.syncGuiUrl + "/rest/config/devices/" + encodeURIComponent(client.deviceId),
      { headers },
    );
    assert.equal(deviceResponse.status, 200);
    const device = await deviceResponse.json() as { deviceID?: string };
    assert.ok(device.deviceID && sameDeviceId(device.deviceID, client.deviceId));

    const folderResponse = await fetch(
      fixture.syncGuiUrl + "/rest/config/folders/syncpeer-lan",
      { headers },
    );
    assert.equal(folderResponse.status, 200);
    const folder = await folderResponse.json() as {
      devices?: Array<{ deviceID?: string }>;
    };
    assert.ok(folder.devices?.some(
      ({ deviceID }) => Boolean(deviceID && sameDeviceId(deviceID, client.deviceId)),
    ));
    console.log("Real Syncthing approval integration test passed.");
  } finally {
    await fixture?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
