import assert from "node:assert/strict";
import { test } from "node:test";
import { androidPeerTargets, androidPeerCdpPort } from "./android-peer-targets.ts";

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
