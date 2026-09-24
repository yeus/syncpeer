import assert from "node:assert/strict";
import test from "node:test";
import {
  documentStoragePreparationIssue,
  formatDocumentStoragePreparationError,
  formatProfileCreationError,
  safeNativeFailureText,
} from "../packages/app/src/app/storageErrors.ts";

test("profile creation reports its reason without exposing a local path", () => {
  assert.equal(formatProfileCreationError(new Error("Replica root is busy")),
    "The encrypted profile could not be created. Reason: the private storage directory is already in use by another Syncpeer process.");
  const message = formatProfileCreationError(new Error("Could not open /home/alice/private/profile: unusual failure"));
  assert.match(message, /Could not open \[path\]: unusual failure/);
  assert.doesNotMatch(message, /\/home\/alice/);
});

test("diagnostic failure details also redact sandbox paths", () => {
  assert.equal(safeNativeFailureText(new Error("Could not open /workspace/private/store.sqlite: invalid")),
    "Could not open [path]: invalid");
});

test("explains private document storage initialization on first startup", () => {
  assert.equal(
    formatDocumentStoragePreparationError(0),
    "Syncpeer could not open its private local data store for settings and downloaded files. No user-selected or peer folder was accessed; downloading is paused.",
  );
});

test("explains a protected credential failure during startup", () => {
  assert.equal(
    formatDocumentStoragePreparationError(0, new Error("Protected credential operation failed; use manual unlock.")),
    "Syncpeer could not open its private local data store for settings and downloaded files. Reason: the protected credential store is locked or unavailable. No user-selected or peer folder was accessed; downloading is paused.",
  );
});

test("explains invalid protected metadata without exposing local paths", () => {
  assert.equal(
    formatDocumentStoragePreparationError(0, new Error("Protected metadata key is invalid; recovery or local reset is required.")),
    "Syncpeer could not open its private local data store for settings and downloaded files. Reason: protected metadata is invalid and needs recovery or a local reset. No user-selected or peer folder was accessed; downloading is paused.",
  );
});

test("explains protected identity and metadata bridge failures", () => {
  assert.match(
    formatDocumentStoragePreparationError(0, new Error("Protected identity storage is unavailable.")),
    /Reason: the protected device identity could not be read or created\./,
  );
  assert.match(
    formatDocumentStoragePreparationError(0, new Error("Protected metadata key operation failed.")),
    /Reason: the protected metadata key could not be read or created\./,
  );
});

test("reads structured native errors from the Tauri bridge", () => {
  assert.match(
    formatDocumentStoragePreparationError(0, { message: "Permission denied (os error 13)" }),
    /Reason: the operating system denied access to Syncpeer's private app-data directory\./,
  );
});

test("explains common operating-system storage failures", () => {
  assert.match(
    formatDocumentStoragePreparationError(0, new Error("Permission denied (os error 13)")),
    /Reason: the operating system denied access to Syncpeer's private app-data directory\./,
  );
  assert.match(
    formatDocumentStoragePreparationError(0, new Error("No space left on device")),
    /Reason: Syncpeer's private app-data volume is out of free space\./,
  );
});

test("explains shared-folder preparation for one folder", () => {
  assert.equal(
    formatDocumentStoragePreparationError(1),
    "Syncpeer could not prepare local storage for the shared folder. Downloading is paused; check the vault and folder access.",
  );
});

test("uses plural wording for multiple shared folders", () => {
  assert.equal(
    formatDocumentStoragePreparationError(2),
    "Syncpeer could not prepare local storage for the shared folders. Downloading is paused; check the vault and folder access.",
  );
});

test("keeps an unknown native failure honest", () => {
  assert.equal(
    formatDocumentStoragePreparationError(1, new Error("Metadata database: sqlite error code 14")),
    "Syncpeer could not prepare local storage for the shared folder. Reason: the native storage operation reported: Metadata database: sqlite error code 14. Downloading is paused; check the vault and folder access.",
  );
});

test("redacts paths from an unknown native failure", () => {
  assert.equal(
    formatDocumentStoragePreparationError(0, new Error("Could not open /home/alice/.local/share/syncpeer/metadata.sqlite: unusual failure")),
    "Syncpeer could not open its private local data store for settings and downloaded files. Reason: the native storage operation reported: Could not open [path]: unusual failure. No user-selected or peer folder was accessed; downloading is paused.",
  );
});

test("does not send users to the session log when no native detail exists", () => {
  const message = formatDocumentStoragePreparationError(0, { operation: "syncpeer_profile_storage_root" });
  assert.doesNotMatch(message, /session log/i);
  assert.match(message, /native storage bridge returned no diagnostic detail/);
});

test("offers a private-data reset for unrecognized app-owned storage", () => {
  const issue = documentStoragePreparationIssue(
    0,
    new Error("SYNCPEER_PRIVATE_STORAGE_UNRECOGNIZED: unsupported format marker"),
  );
  assert.equal(issue.canResetPrivateStorage, true);
  assert.equal(
    issue.message,
    "Syncpeer found existing data in its private local storage, but this version cannot recognize or safely use it. " +
      "You can reset Syncpeer's private local data and start fresh. This removes local settings, downloaded copies, " +
      "unsynced edits, and this device's identity. External folders and other devices are not changed.",
  );
});

test("does not offer reset for unrelated native failures", () => {
  const issue = documentStoragePreparationIssue(0, new Error("Permission denied (os error 13)"));
  assert.equal(issue.canResetPrivateStorage, false);
});
