import assert from "node:assert/strict";
import { test } from "node:test";
import { externalApiSkipReason, externalPeerSkipReason } from "./external-test-gate.ts";

test("saved peer state never opts the umbrella into external tests", () => {
  assert.match(externalPeerSkipReason({}), /opt in/i);
  assert.match(externalPeerSkipReason({ SYNCPEER_DEV_SERVER_DEVICE_ID: "SAVED" }), /opt in/i);
  assert.match(externalPeerSkipReason({ SYNCPEER_RUN_EXTERNAL_CHECKS: "1" }), /device ID/i);
  assert.equal(externalPeerSkipReason({ SYNCPEER_RUN_EXTERNAL_CHECKS: "1",
    SYNCPEER_DEV_SERVER_DEVICE_ID: "EXPLICIT" }), undefined);
});

test("an API URL alone does not opt the umbrella into external tests", () => {
  assert.match(externalApiSkipReason({}, "https://synthetic.invalid/"), /opt in/i);
  assert.match(externalApiSkipReason({ SYNCPEER_RUN_EXTERNAL_CHECKS: "1" }, undefined), /URL/i);
  assert.equal(externalApiSkipReason({ SYNCPEER_RUN_EXTERNAL_CHECKS: "1" },
    "https://synthetic.invalid/"), undefined);
});
