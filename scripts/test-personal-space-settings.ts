import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPersonalSpaceSettings,
  folderRetentionPolicyFromSettings,
  normalizePersonalSpaceSettings,
  setDeviceFolderSelection,
  updateFolderRetention,
} from "../packages/core/dist/sync/personalSpaceSettings.js";

test("shared settings start versioned with a two-copy folder default", () => {
  const settings = defaultPersonalSpaceSettings("roster-1");
  assert.deepEqual(settings, { format: 1, rosterHead: "roster-1", folders: {} });
  assert.deepEqual(folderRetentionPolicyFromSettings(settings, "photos"), {
    format: 1, folderId: "photos", minimumCopies: 2, revision: 1,
    rosterHead: "roster-1", holders: [],
  });
});

test("favorite and exclusion selections are isolated per owned device", () => {
  const original = defaultPersonalSpaceSettings("roster-1");
  const phone = setDeviceFolderSelection(original, "photos", "phone", {
    favorites: [{ key: "folder:photos:", folderId: "photos", path: "", name: "Photos", kind: "folder" }],
    exclusions: [],
  });
  const laptop = setDeviceFolderSelection(phone, "photos", "laptop", {
    favorites: [], exclusions: [{ folderId: "photos", path: "private", kind: "folder" }],
  });
  assert.deepEqual(original.folders, {});
  assert.equal(laptop.folders.photos.devices.phone.favorites[0]?.path, "");
  assert.equal(laptop.folders.photos.devices.laptop.exclusions[0]?.path, "private");
  assert.equal(laptop.folders.photos.retentionRevision, 1,
    "favorite changes must not invalidate complete-copy evidence");
});

test("retention changes advance only that folder policy revision", () => {
  const initial = setDeviceFolderSelection(defaultPersonalSpaceSettings("roster-1"), "photos", "phone", {
    favorites: [], exclusions: [],
  });
  const updated = updateFolderRetention(initial, "photos", {
    minimumCopies: 3,
    holders: [{ id: "phone", kind: "syncpeer" }, { id: "nas", kind: "syncthing" }],
  });
  assert.deepEqual(folderRetentionPolicyFromSettings(updated, "photos"), {
    format: 1, folderId: "photos", minimumCopies: 3, revision: 2,
    rosterHead: "roster-1", holders: [
      { id: "phone", kind: "syncpeer" }, { id: "nas", kind: "syncthing" },
    ],
  });
  assert.equal(updated.folders.photos.devices.phone.favorites.length, 0);
});

test("unknown or incomplete shared settings fail closed", () => {
  assert.throws(() => normalizePersonalSpaceSettings({ format: 2, rosterHead: "roster", folders: {} }),
    /unsupported/i);
  assert.throws(() => normalizePersonalSpaceSettings({ format: 1, rosterHead: "roster", folders: {
    photos: { minimumCopies: 2 },
  } }), /invalid/i);
});
