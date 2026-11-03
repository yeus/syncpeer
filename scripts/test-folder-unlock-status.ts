import assert from "node:assert/strict";
import test from "node:test";
import { createInitialSessionState } from "../packages/core/src/ui/sessionPolicies.ts";
import { createDeviceActions } from "../packages/app/src/app/deviceActions.ts";
import { createInitialState, folderIsLocked, folderLockLabel, folderUnlockError,
  reconcileFolderUnlockStatuses } from "../packages/app/src/app/state.ts";

const PEER = "RXB676UZHQX3SONXROHZ7M3DY2VEMB6LCGQCAG5QJ2VIEDX4RIUQ";

const encryptedFolder = (needsPassword: boolean, passwordError?: string) => ({
  id: "photos", label: "Photos", readOnly: true, encrypted: true,
  needsPassword, ...(passwordError ? { passwordError } : {}),
});

test("every encrypted folder retains an authoritative locked/unlocked label across navigation and offline", () => {
  const state = createInitialState(null);
  state.connection.remoteId = PEER;
  state.session.folders = [encryptedFolder(true) as never];
  assert.equal(folderLockLabel(state, "photos"), "locked");
  assert.equal(folderIsLocked(state, "photos"), true);
  state.session.folders = [encryptedFolder(false) as never];
  state.activeTab = "devices";
  state.session.isConnected = false;
  assert.equal(folderLockLabel(state, "photos"), "unlocked");
  assert.equal(folderIsLocked(state, "photos"), false);
  state.session.folders = [encryptedFolder(true, "Password does not match") as never];
  assert.equal(folderLockLabel(state, "photos"), "unlock error");
  assert.match(folderUnlockError(state, "photos"), /Password does not match/);
});

test("unlocking, failure, and later successful verification have distinct persistent statuses", () => {
  const state = createInitialState(null);
  state.connection.remoteId = PEER;
  state.session.folders = [encryptedFolder(true) as never];
  state.passwords.unlockStatusByFolder[`${PEER}:photos`] = { phase: "unlocking", message: "" };
  assert.equal(folderLockLabel(state, "photos"), "unlocking…");
  state.passwords.unlockStatusByFolder[`${PEER}:photos`] = {
    phase: "error", message: "Credential verification failed",
  };
  assert.equal(folderLockLabel(state, "photos"), "unlock error");
  assert.match(folderUnlockError(state, "photos"), /verification failed/);
  state.session.folders = [encryptedFolder(false) as never];
  reconcileFolderUnlockStatuses(state);
  assert.equal(folderLockLabel(state, "photos"), "unlocked");
  assert.equal(folderUnlockError(state, "photos"), "");
});

test("Save and unlock exposes progress synchronously, and storage errors remain folder-specific", async () => {
  const state = createInitialState(null);
  state.connection.remoteId = PEER;
  state.session.folders = [encryptedFolder(true) as never];
  let rejectSave!: (error: Error) => void;
  const pendingSave = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  const actions = createDeviceActions({
    state, client: {} as never,
    sessionStore: { actions: {
      setFolderPasswords: async () => undefined,
    } } as never,
    refreshOverview: async () => undefined,
    refreshActiveView: async () => undefined,
    refreshCurrentDeviceId: async () => undefined,
    connectToDevice: async () => undefined,
    savePasswords: () => pendingSave,
  });
  actions.updateFolderPasswordDraft("photos", "wrong");
  const operation = actions.saveFolderPassword("photos");
  assert.equal(folderLockLabel(state, "photos"), "unlocking…");
  rejectSave(new Error("Secure credential write rejected"));
  await assert.rejects(operation, /Secure credential write rejected/);
  assert.equal(folderLockLabel(state, "photos"), "unlock error");
  assert.match(folderUnlockError(state, "photos"), /Secure credential write rejected/);
  assert.equal(folderIsLocked(state, "photos"), true);
});

test("password saved while peer offline remains unverified, not falsely unlocked", async () => {
  const state = createInitialState(null);
  state.connection.remoteId = PEER;
  state.session.folders = [encryptedFolder(true) as never];
  const actions = createDeviceActions({
    state, client: {} as never,
    sessionStore: { actions: { setFolderPasswords: async () => undefined } } as never,
    refreshOverview: async () => undefined,
    refreshActiveView: async () => undefined,
    refreshCurrentDeviceId: async () => undefined,
    connectToDevice: async () => undefined,
    savePasswords: async () => undefined,
  });
  actions.updateFolderPasswordDraft("photos", "synthetic");
  await actions.saveFolderPassword("photos");
  assert.equal(folderLockLabel(state, "photos"), "awaiting verification");
  assert.equal(folderIsLocked(state, "photos"), true);
});

test("unverified live unlock does not falsely accuse an otherwise correct password", async () => {
  const state = createInitialState(null);
  state.connection.remoteId = PEER;
  state.session.isConnected = true;
  state.session.folders = [encryptedFolder(true) as never];
  let passwordSent = "";
  const live = { ...createInitialSessionState(), phase: "connected" as const,
    remoteFs: {} as never, folders: [encryptedFolder(true) as never] };
  const actions = createDeviceActions({
    state, client: {} as never,
    sessionStore: { actions: {
      setFolderPasswords: async (passwords: Record<string, string>) => {
        passwordSent = passwords.photos;
      },
      refreshOverview: async () => undefined,
    }, getState: () => live } as never,
    refreshOverview: async () => undefined, refreshActiveView: async () => undefined,
    refreshCurrentDeviceId: async () => undefined, connectToDevice: async () => undefined,
    savePasswords: async () => undefined,
  });
  actions.updateFolderPasswordDraft("photos", "synthetic-known-correct-password");
  await assert.rejects(actions.saveFolderPassword("photos"), /could not be verified/i);
  assert.equal(passwordSent, "synthetic-known-correct-password");
  assert.doesNotMatch(folderUnlockError(state, "photos"), /check its password|does not match/i);
});

test("an explicit BEP password-token mismatch is reported distinctly", async () => {
  const state = createInitialState(null);
  state.connection.remoteId = PEER;
  state.session.isConnected = true;
  const live = { ...createInitialSessionState(), phase: "connected" as const,
    remoteFs: {} as never,
    folders: [encryptedFolder(true, "Encryption password does not match this folder.") as never] };
  const actions = createDeviceActions({
    state, client: {} as never,
    sessionStore: { actions: {
      setFolderPasswords: async () => undefined,
      refreshOverview: async () => undefined,
    }, getState: () => live } as never,
    refreshOverview: async () => undefined, refreshActiveView: async () => undefined,
    refreshCurrentDeviceId: async () => undefined, connectToDevice: async () => undefined,
    savePasswords: async () => undefined,
  });
  actions.updateFolderPasswordDraft("photos", "synthetic-wrong-password");
  await assert.rejects(actions.saveFolderPassword("photos"), /does not match this folder/i);
  assert.match(folderUnlockError(state, "photos"), /does not match this folder/i);
});
