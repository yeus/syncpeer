import assert from "node:assert/strict";
import {
  canonicalRecordPath,
  sidecarManifestPath,
  sidecarOpPath,
} from "../packages/core/src/pim/index.ts";

function buildFolderPath(root: string, relative: string): string {
  const normalizedRoot = root.replace(/\/+$/g, "");
  const normalizedRel = relative.replace(/^\/+/g, "");
  return `${normalizedRoot}/${normalizedRel}`;
}

function run(): void {
  const folderRoot = "syncpeer-pim";
  const contactPath = canonicalRecordPath({
    domain: "contacts",
    collectionId: "default",
    recordId: "alice",
  });
  const eventPath = canonicalRecordPath({
    domain: "calendar",
    collectionId: "default",
    recordId: "event-123",
  });
  const manifestPath = sidecarManifestPath("contacts", "default");
  const opPath = sidecarOpPath({
    domain: "calendar",
    collectionId: "default",
    epoch: "2026-05",
    opId: "devA-99",
  });

  assert.equal(
    buildFolderPath(folderRoot, contactPath),
    "syncpeer-pim/syncpeer/pim/contacts/collections/default/entries/alice.vcf",
  );
  assert.equal(
    buildFolderPath(folderRoot, eventPath),
    "syncpeer-pim/syncpeer/pim/calendar/collections/default/entries/event-123.ics",
  );
  assert.equal(
    buildFolderPath(folderRoot, manifestPath),
    "syncpeer-pim/syncpeer/pim/contacts/collections/default/meta/manifest.json",
  );
  assert.equal(
    buildFolderPath(folderRoot, opPath),
    "syncpeer-pim/syncpeer/pim/calendar/collections/default/meta/ops/2026-05/devA-99.json",
  );

  console.log("syncthing pim stub passed");
}

run();

