import assert from "node:assert/strict";
import {
  canonicalRecordPath,
  mergeOperationIntoSnapshot,
  sidecarOpPath,
  type PimOperationEnvelope,
} from "../packages/core/src/pim/index.ts";

const refPath = canonicalRecordPath({
  domain: "contacts",
  collectionId: "personal",
  recordId: "alice",
});
assert.equal(refPath, "syncpeer/pim/contacts/collections/personal/entries/alice.vcf");

const opPath = sidecarOpPath({
  domain: "calendar",
  collectionId: "main",
  epoch: "2026-05",
  opId: "devA-42",
});
assert.equal(opPath, "syncpeer/pim/calendar/collections/main/meta/ops/2026-05/devA-42.json");

const sanitizedPath = canonicalRecordPath({
  domain: "calendar",
  collectionId: "team calendar",
  recordId: "event/with:chars",
});
assert.equal(
  sanitizedPath,
  "syncpeer/pim/calendar/collections/team_calendar/entries/event_with_chars.ics",
);

const baseOp: PimOperationEnvelope = {
  opId: "devA-1",
  domain: "contacts",
  collectionId: "personal",
  recordId: "alice",
  deviceId: "devA",
  createdAtMs: 1,
  updatedAtMs: 1,
  payloadHash: "x1",
  deleted: false,
};
const nextOp: PimOperationEnvelope = {
  ...baseOp,
  opId: "devB-2",
  deviceId: "devB",
  updatedAtMs: 2,
  payloadHash: "x2",
};

const first = mergeOperationIntoSnapshot(null, baseOp, "BEGIN:VCARD\nFN:Alice\nEND:VCARD\n");
assert.equal(first.snapshot.active?.versionId, "devA-1");

const second = mergeOperationIntoSnapshot(first.snapshot, nextOp, "BEGIN:VCARD\nFN:Alice B\nEND:VCARD\n");
assert.equal(second.snapshot.active?.versionId, "devB-2");
assert.equal(second.snapshot.lineage.length, 2);

const oldOp: PimOperationEnvelope = {
  ...baseOp,
  opId: "devC-0",
  deviceId: "devC",
  updatedAtMs: 0,
};
const third = mergeOperationIntoSnapshot(
  second.snapshot,
  oldOp,
  "BEGIN:VCARD\nFN:Alice Old\nEND:VCARD\n",
);
assert.equal(third.snapshot.active?.versionId, "devB-2");
assert.equal(third.snapshot.lineage.length, 3);

const tombstoneOp: PimOperationEnvelope = {
  ...baseOp,
  opId: "devB-3",
  deviceId: "devB",
  updatedAtMs: 3,
  deleted: true,
};
const deleted = mergeOperationIntoSnapshot(third.snapshot, tombstoneOp, "");
assert.equal(deleted.snapshot.deleted, true);
assert.equal(deleted.snapshot.active, null);

console.log("pim checks passed");
