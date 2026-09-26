export { loadEncryptedDiskMetadata, readEncryptedDiskRange, writeEncryptedDiskFile, createEncryptedDownloadSink } from "./sync/encryptedFilesystem.js";
export type { EncryptedFileSource } from "./sync/encryptedFilesystem.js";
export { readEncryptedNamespace } from "./sync/encryptedNamespace.js";
export type { EncryptedNamespaceEntry } from "./sync/encryptedNamespace.js";
export { deriveUntrustedFolderCrypto } from "./core/model/untrusted.js";
export type { UntrustedFolderCrypto } from "./core/model/untrusted.js";
export type { BepFileInfo } from "./core/protocol/bep.js";
export type { ReplicaSource } from "./sync/replicaIndex.js";
export type { LocalReplicaEdit } from "./sync/replicaIndex.js";
export { createReplicaFileSource } from "./sync/replicaFileSource.js";
export { openReplicaWritableFile } from "./sync/replicaWritableFile.js";
export type { ReplicaWritableFile, ReplicaWritableScratch } from "./sync/replicaWritableFile.js";
export { loadCiphertextDiskMetadata, readCiphertextBlock, receiveCiphertextFile } from "./sync/ciphertextFilesystem.js";
export { createCiphertextIndex, prepareCiphertextUpdate, completeCiphertextUpdate, encodeCiphertextIndex, decodeCiphertextIndex,
  loadCiphertextIndex, saveCiphertextIndex } from "./sync/ciphertextIndex.js";
export type { CiphertextIndex, CiphertextFolderIdentity } from "./sync/ciphertextIndex.js";
export { createCiphertextReplica } from "./sync/ciphertextReplica.js";
export { openCiphertextView } from "./sync/ciphertextView.js";
export { createCredentialVault } from "./sync/credentialVault.js";
export type { CredentialVaultRecord, PersonalSpaceRecoveryBackup, RememberedUnlockSecretStore } from "./sync/credentialVault.js";
export { createCredentialVaultStorage, createPersonalSpaceBootstrapStorage } from "./sync/credentialVaultStorage.js";
export { createPersonalSpaceBootstrap, openPersonalSpaceBootstrap, rewrapPersonalSpaceBootstrap,
  personalVaultKey, settingsFolderPassword, wrapPersonalSpaceBootstrap } from "./sync/personalSpaceBootstrap.js";
export type { PersonalSpace, PersonalSpaceBootstrap } from "./sync/personalSpaceBootstrap.js";
export { createOwnedDeviceIdentity, createOwnedRecoveryKit, openOwnedRecoveryKit, openOwnedDeviceSigningKey,
  resolveApprovedPeerDeviceIds, resolveFolderShareDevices,
  settingsFolderDevices, signSpaceMembershipUpdate, verifySpaceDeviceMembership } from "./sync/personalSpaceSharing.js";
export type { FolderShareTarget, OwnedDeviceIdentity, OwnedRecoveryKit, SpaceDeviceMembershipTrust,
  OwnedSpaceDevice, SpaceMembershipUpdate } from "./sync/personalSpaceSharing.js";
export { createPairingInvitation, createPairingRequest, openPairingSession,
  sealPairingTransfer, openPairingTransfer } from "./sync/personalSpacePairing.js";
export type { PairingInvitation, PairingRequest, PairingTransfer } from "./sync/personalSpacePairing.js";
export { resolvePersonalSpaceChanges } from "./sync/personalSpaceChanges.js";
export type { PersonalSpaceChange } from "./sync/personalSpaceChanges.js";
export { materializePersonalSpaceSettings } from "./sync/personalSpaceSettings.js";
export { createPersonalSpaceSettingsJournal } from "./sync/personalSpaceSettingsJournal.js";
export { createSpaceMembershipJournal } from "./sync/spaceMembershipJournal.js";
export { createDocumentFilesystem } from "./sync/documentFilesystem.js";
export { changesSessionConfiguration, dispatchDocumentCommand } from "./sync/documentCommands.js";
export { createDocumentCache } from "./sync/documentCache.js";
export { createEncryptedScratch } from "./sync/encryptedScratch.js";
export { createNativeFilesystem } from "./sync/nativeFilesystem.js";
export type { NativeFilesystemRequest } from "./sync/nativeFilesystem.js";
export { saveEncryptedReplicaIndex, loadEncryptedReplicaIndex } from "./sync/encryptedReplicaPersistence.js";
export { createEncryptedReplicaStorage } from "./sync/encryptedReplicaStorage.js";
export type { ReplicaByteStorage } from "./sync/encryptedReplicaStorage.js";
export { createFolderReplica } from "./sync/replicaStorage.js";
export { createFolderRegistry } from "./sync/folderRegistry.js";
export { createReplicaController } from "./sync/replicaControl.js";
export type { FolderRegistration, RegisteredFolderState, OpenedFolder } from "./sync/folderRegistry.js";
