import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePersonalSpaceChanges } from "../packages/core/dist/sync/personalSpaceChanges.js";

test("changes to unrelated settings merge regardless of arrival order", () => {
  const changes = [
    { id: "a", deviceId: "phone", path: ["folder", "photos", "sharing"], parents: [], value: ["personal-space"] },
    { id: "b", deviceId: "desktop", path: ["device", "desktop", "favorites", "photos"], parents: [], value: ["2026/"] },
  ];
  const first = resolvePersonalSpaceChanges(changes);
  assert.deepEqual(first, resolvePersonalSpaceChanges([...changes].reverse()));
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.values.length, 2);
});

test("causally ordered updates select the descendant", () => {
  const result = resolvePersonalSpaceChanges([
    { id: "later", deviceId: "phone", path: ["profile", "name"], parents: ["earlier"], value: "new" },
    { id: "earlier", deviceId: "phone", path: ["profile", "name"], parents: [], value: "old" },
  ]);
  assert.deepEqual(result.values, [{ path: ["profile", "name"], value: "new", heads: ["later"] }]);
});

test("deletions are explicit tombstones rather than missing settings", () => {
  const result = resolvePersonalSpaceChanges([
    { id: "old", deviceId: "phone", path: ["folder", "photos"], parents: [], value: "Photos" },
    { id: "gone", deviceId: "phone", path: ["folder", "photos"], parents: ["old"], deleted: true },
  ]);
  assert.deepEqual(result.values, [{ path: ["folder", "photos"], value: undefined, heads: ["gone"], deleted: true }]);
});

test("concurrent updates to the same setting remain visible as a conflict", () => {
  const result = resolvePersonalSpaceChanges([
    { id: "phone-edit", deviceId: "phone", path: ["profile", "name"], parents: [], value: "A" },
    { id: "laptop-edit", deviceId: "laptop", path: ["profile", "name"], parents: [], value: "B" },
  ]);
  assert.deepEqual(result.values, []);
  assert.deepEqual(result.conflicts[0]?.heads, ["laptop-edit", "phone-edit"]);
});

test("concurrent equivalent updates are not reported as a conflict", () => {
  const result = resolvePersonalSpaceChanges([
    { id: "phone", deviceId: "phone", path: ["folder", "photos", "sharing"], parents: [],
      value: { target: "personal-space", enabled: true } },
    { id: "laptop", deviceId: "laptop", path: ["folder", "photos", "sharing"], parents: [],
      value: { enabled: true, target: "personal-space" } },
  ]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.values[0]?.heads, ["laptop", "phone"]);
});

test("a missing ancestor or reused event ID fails closed", () => {
  assert.throws(() => resolvePersonalSpaceChanges([
    { id: "child", deviceId: "phone", path: ["profile", "name"], parents: ["missing"], value: "A" },
  ]), /missing/i);
  assert.throws(() => resolvePersonalSpaceChanges([
    { id: "same", deviceId: "phone", path: ["profile", "name"], parents: [], value: "A" },
    { id: "same", deviceId: "phone", path: ["profile", "name"], parents: [], value: "B" },
  ]), /duplicate/i);
});

test("a hidden ancestry cycle is rejected even if another branch has a head", () => {
  assert.throws(() => resolvePersonalSpaceChanges([
    { id: "a", deviceId: "phone", path: ["profile", "name"], parents: ["b"], value: "A" },
    { id: "b", deviceId: "phone", path: ["profile", "name"], parents: ["a"], value: "B" },
    { id: "c", deviceId: "laptop", path: ["profile", "name"], parents: [], value: "C" },
  ]), /cyclic/i);
});
