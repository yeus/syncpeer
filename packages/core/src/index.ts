export { certificateDerFromPem, createSyncpeerCoreClient, deviceIdFromCertificate,
  UploadOutcomeUnknownError, withMetadataSession } from "./client.js";
export { createReplicaController } from "./sync/replicaControl.js";
export type { ReplicaState } from "./sync/replicaControl.js";
export {
  DEFAULT_FAVORITE_IGNORE_PATTERNS,
  classifyFavoritePath,
  collectFavoriteFiles,
} from "./ui/favoriteSelection.js";
export type {
  FavoriteExclusion,
  FavoritePathState,
} from "./ui/favoriteSelection.js";
export { cacheQuotaBytes, defaultFolderSettings, defaultProfileSettings, normalizeProfileSettings, planCacheEvictions } from "./sync/profileSettings.js";
export type { CacheCandidate, SyncpeerFolderSettings, SyncpeerProfileSettings } from "./sync/profileSettings.js";
export {
  assessFolderRetention,
  authorizeReplicaRelease,
  createDangerousLocalRelease,
  defaultFolderRetentionPolicy,
  folderManifestDigest,
  signReplicaCompletion,
  signRetentionReleaseProposal,
  verifyDangerousLocalRelease,
  verifyRemoteReplicaManifest,
} from "./sync/folderRetention.js";
export {
  defaultPersonalSpaceSettings,
  folderRetentionPolicyFromSettings,
  normalizePersonalSpaceSettings,
  setDeviceFolderSelection,
  updateFolderRetention,
} from "./sync/personalSpaceSettings.js";
export { createPeerSessionManager, preferredPeerDirection } from "./sync/peerSessionManager.js";
export type {
  ManagedPeerSession,
  PeerConnectionDirection,
  PeerSessionCandidate,
  PeerSessionManager,
} from "./sync/peerSessionManager.js";
export { startIncomingPeerService } from "./sync/incomingPeerService.js";
export type { IncomingPeerServiceOptions } from "./sync/incomingPeerService.js";
export { acceptPairingTransfer, joinPersonalSpace } from "./sync/personalSpacePairingTransport.js";
export { createPairingInvitation, createPairingRequest, openPairingSession,
  openPairingTransfer, sealPairingTransfer } from "./sync/personalSpacePairing.js";
export type { PairingInvitation, PairingRequest, PairingTransfer,
  PersonalSpacePairingTransfer } from "./sync/personalSpacePairing.js";
export type {
  DeviceFolderSelection,
  PersonalSpaceSettings,
  SharedFolderSettings,
} from "./sync/personalSpaceSettings.js";
export type {
  DangerousLocalRelease,
  FolderManifestEntry,
  FolderRetentionPolicy,
  ReplicaCompletion,
  RetentionReleaseProposal,
} from "./sync/folderRetention.js";
export {
  classifyRuntimeArchitecture,
  classifyRuntimePlatform,
  createAppBuildInfo,
  formatAppBuildInfo,
} from "./appInfo.js";
export type {
  AppBuildInfo,
  AppBuildMode,
  AppRuntimeArchitecture,
  AppRuntimeEnvironment,
  AppRuntimePlatform,
  AppRuntimeSurface,
} from "./appInfo.js";
export type {
  SyncpeerCoreClient,
  SyncpeerConnectOptions,
  ConnectionScope,
  DiscoveredCandidate,
  SyncpeerHostAdapter,
  SharedFolder,
  SyncpeerSessionHandle,
  SyncpeerSessionClosure,
  SyncpeerQuicConnectOptions,
  SyncpeerTlsConnectOptions,
  SyncpeerTlsListenOptions,
  SyncpeerTlsListener,
  SyncpeerAcceptedTlsSocket,
  SyncpeerTlsSocket,
} from "./client.js";
export {
  createNodeHostAdapter,
  createNodeSessionTransport,
  createNodeSyncpeerClient,
  resolveNodeLocalDiscovery,
} from "./node.js";
export { isTransportFailure, RemoteFs } from "./core/model/remoteFs.js";
export type { FolderInfo, FolderStats, FileEntry, FileBlock, RemoteDeviceInfo, FolderSyncState, FileDeleteOptions } from "./core/model/remoteFs.js";
export { createSyncpeerSessionStore } from "./ui/sessionStore.js";
export { createConnectionLifecycle, retryDelayMs } from "./ui/connectionLifecycle.js";
export type { ConnectionLifecycle, ConnectionLifecyclePhase, ConnectionLifecycleState } from "./ui/connectionLifecycle.js";
export { downloadRemoteFile } from "./transfer/download.js";
export type { DownloadRange, RangeDigest, CachedRangeStorage } from "./transfer/blockReuse.js";
export {
  compareVersionVectors,
  deleteFolderFile,
  defaultFolderSyncPolicy,
  planFolderSync,
  synchronizeFolder,
  unsubscribeFolder,
} from "./sync/folderSync.js";
export type {
  ExternalDeletionPolicy,
  FolderDeleteResult,
  FolderSyncAction,
  FolderSyncBaseline,
  FolderSyncBaselineFile,
  FolderSyncEvent,
  FolderSyncPlan,
  FolderSyncPolicy,
  FolderSyncRemote,
  FolderSyncResult,
  FolderSyncStorage,
  FolderUnsubscribeResult,
  FolderVersioningMode,
  LocalSyncFile,
} from "./sync/folderSync.js";
export { createDuplexChannel, createStream } from "./transfer/frpBus.js";
export { createPortFromTransport } from "./transfer/frpTransport.js";
export type { DuplexChannel, Port, Stream } from "./transfer/frpBus.js";
export type { DuplexTransport } from "./transfer/frpTransport.js";
export type {
  DownloadCheckpoint,
  FileDownloadMetadata,
  FileDownloadResult,
  FileDownloadSink,
  FileTransferMessage,
} from "./transfer/stream.js";
export { createCheckpointedDownloadSink, RemoteMetadataChangedError, DownloadInterruptedError } from "./transfer/stream.js";
export {
  canonicalRecordPath,
  collectionRootPath,
  extensionForFormat,
  formatForDomain,
  sidecarManifestPath,
  sidecarOpPath,
  sidecarTombstonePath,
  createEmptySnapshot,
  mergeOperationIntoSnapshot,
} from "./pim/index.js";
export type {
  SessionPendingState,
  SessionPhase,
  SessionRuntimeActions,
  SessionRuntimeDeps,
  SessionSnapshotState,
  SessionState,
  SessionTraceEvent,
  SessionTransport,
  SyncpeerSessionStore,
} from "./ui/sessionTypes.js";
export type {
  PimDomain,
  PimMergeResult,
  PimOperationEnvelope,
  PimRecordFormat,
  PimRecordRef,
  PimRecordSnapshot,
  PimRecordVersion,
} from "./pim/index.js";
