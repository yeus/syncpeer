import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { completeFirstRunDeviceName, readCurrentDeviceId } from "./ui-helpers.js";

const ownedRoot = () => {
  const home = process.env.XDG_DATA_HOME;
  const fixture = process.env.SYNCPEER_PRIVATE_KEYRING_ROOT;
  assert.ok(home && fixture && home.startsWith(`${fixture}/data`),
    "Reset acceptance must run inside the disposable private keyring fixture.");
  return { home, fixture };
};

const appPids = () => {
  const app = process.env.SYNCPEER_LAN_APP_BINARY;
  assert.ok(app, "Packaged app binary is required.");
  return fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).filter(pid => {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(app); }
    catch { return false; }
  });
};

describe("Packaged Linux local reset", () => {
  it("restarts with cleared app data and never deletes unrelated selected folders", async () => {
    const { home, fixture } = ownedRoot();
    const ownMarker = path.join(home, "dev.syncpeer.app", "reset-test-marker");
    const selectedMarker = path.join(fixture, "external-selected", "keep.txt");
    await completeFirstRunDeviceName(browser, "Synthetic reset owner");
    const originalId = await readCurrentDeviceId(browser);
    assert.ok(originalId);
    fs.mkdirSync(path.dirname(ownMarker), { recursive: true });
    fs.writeFileSync(ownMarker, "local-ephemeral");
    fs.mkdirSync(path.dirname(selectedMarker), { recursive: true });
    fs.writeFileSync(selectedMarker, "keep-external");
    const prior = new Set(appPids());
    assert.ok(prior.size, "The packaged desktop process must be running before reset.");

    await browser.execute(() => {
      const runtime = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
      const invoke = runtime.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error("The desktop native reset command is unavailable.");
      // The backend deliberately terminates/restarts during this asynchronous RPC.
      void invoke("syncpeer_reset_local_data", { confirmation: "RESET LOCAL DATA" }).catch(() => {});
      return true;
    });
    const deadline = Date.now() + 90_000;
    let restarted = false;
    while (Date.now() < deadline) {
      restarted = !fs.existsSync(ownMarker) && appPids().some(pid => !prior.has(pid));
      if (restarted) break;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    assert.equal(restarted, true,
      "Packaged app did not clear its private marker and restart with a new PID.");
    assert.equal(fs.readFileSync(selectedMarker, "utf8"), "keep-external");
  });
});
