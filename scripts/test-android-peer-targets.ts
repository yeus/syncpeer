import assert from "node:assert/strict";
import { test } from "node:test";
import { androidPeerTargets, androidPeerCdpPort, androidSingleListeningPort,
  androidAppListeningOnPort } from "./android-peer-targets.ts";

test("destructive peer acceptance requires explicit opt-in and two verified emulators", () => {
  const online = ["emulator-5556", "emulator-5558", "synthetic-phone"];
  const verified = (serial: string) => serial.startsWith("emulator-");
  assert.throws(() => androidPeerTargets(online, undefined, false, verified), /reset/i);
  assert.deepEqual(androidPeerTargets(online, undefined, true, verified), online.slice(0, 2));
  assert.throws(() => androidPeerTargets(online, "emulator-5556,synthetic-phone", true, verified), /emulator/i);
  assert.throws(() => androidPeerTargets(online, "emulator-5556,emulator-5556", true, verified), /distinct/i);
  assert.throws(() => androidPeerTargets(online, "emulator-5556,emulator-5560", true, verified), /online/i);
  assert.throws(() => androidPeerTargets(online, undefined, true, () => false), /verified/i);
});

test("each emulator gets a distinct valid debugging port regardless of serial suffix", () => {
  const ports = [5554, 5556, 5558, 5564].map(port => androidPeerCdpPort(`emulator-${port}`));
  assert.equal(new Set(ports).size, ports.length);
  assert.ok(ports.every(port => port > 1024 && port <= 65535));
  assert.throws(() => androidPeerCdpPort("synthetic-phone"));
  assert.throws(() => androidPeerCdpPort("emulator-65535"));
});

test("pairing redirect targets the one actual app listener, not the default sync port", () => {
  const sockets = [
    "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode",
    "0: 00000000:9E15 00000000:0000 0A 0:0 00:0 0 10233 0 1",
    "1: 00000000:55F0 00000000:0000 0A 0:0 00:0 0 10234 0 2",
    "2: 1002000A:98F2 00000000:0000 01 0:0 00:0 0 10233 0 3",
  ].join("\n");
  assert.equal(androidSingleListeningPort(sockets, 10233), 40469);
  assert.equal(androidAppListeningOnPort(sockets, 10234, 22000), true);
  assert.equal(androidAppListeningOnPort(sockets, 10233, 22000), false);
  assert.equal(androidAppListeningOnPort(sockets, 10234, 23000), false);
  assert.throws(() => androidSingleListeningPort(sockets, 10235), /one.*listener/i);
  assert.throws(() => androidSingleListeningPort(sockets.replace("10234", "10233"), 10233), /one.*listener/i);
});
