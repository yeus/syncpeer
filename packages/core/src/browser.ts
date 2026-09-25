export { certificateDerFromPem, createSyncpeerCoreClient, deviceIdFromCertificate,
  UploadOutcomeUnknownError, withMetadataSession } from "./client.js";
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
  SyncpeerDiscoveryFetchInit,
  SyncpeerDiscoveryResponse,
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
  SyncpeerRelayListenOptions,
} from "./client.js";
export { isTransportFailure, RemoteFs } from "./core/model/remoteFs.js";
export type {
  AdvertisedDeviceInfo,
  FileBlock,
  FileDownloadProgress,
  FileEntry,
  FileDeleteOptions,
  FolderInfo,
  FolderStats,
  FolderSyncState,
  RemoteDeviceInfo,
} from "./core/model/remoteFs.js";
export {
  buildConnectionDetails,
  fromConnectionSettings,
  toConnectionSettings,
} from "./ui/connectionState.js";
export type {
  DiscoveryMode,
  StoredConnectionSettingsLike,
} from "./ui/connectionState.js";
export {
  breadcrumbSegments,
  cachedFileKey,
  collectAdvertisedDevices,
  collectAdvertisedFolders,
  favoriteKey,
  folderDisplayName,
  formatEta,
  formatRate,
  isValidSyncthingDeviceId,
  normalizeDeviceId,
  normalizeFolderPasswords,
  normalizePath,
  normalizeSavedDevices,
  sameDeviceId,
  normalizeSyncApprovedIntroducedFolderKeys,
  resolveDirectoryPath,
  sleep,
  syncApprovedFolderKey,
} from "./ui/helpers.js";
export {
  FOLDER_PASSWORD_SCOPE_SEPARATOR,
  folderPasswordScopedKey,
  isScopedFolderPasswordKey,
  resolveFolderPasswordsForDevice,
} from "./ui/sessionPasswords.js";
export type {
  AdvertisedDeviceItem,
  AdvertisedFolderItem,
  BreadcrumbSegment,
  SavedDeviceLike,
} from "./ui/helpers.js";
export {
  createSyncpeerBrowserClient,
  getDefaultDiscoveryServer,
  normalizeDiscoveryServer,
  reportClientError,
} from "./ui/browserClient.js";
export { createSyncpeerSessionStore } from "./ui/sessionStore.js";
export { createConnectionLifecycle, retryDelayMs } from "./ui/connectionLifecycle.js";
export type { ConnectionLifecycle, ConnectionLifecyclePhase, ConnectionLifecycleState } from "./ui/connectionLifecycle.js";
export {
  createTransferNotificationState,
  reduceTransferNotification,
  transferNotificationView,
} from "./ui/transferNotification.js";
export type {
  ActiveTransfer,
  TransferDirection,
  TransferNotificationEvent,
  TransferNotificationState,
  TransferNotificationView,
} from "./ui/transferNotification.js";
export {
  makeReadDirWithRetryFlow,
  makeWaitForFolderIndexToArriveFlow,
  makeWaitForFoldersToPopulateFlow,
} from "./ui/sessionFlows.js";
export { resolvePreferredSourceDeviceId } from "./ui/sessionPolicies.js";
export { sortAndFilterFileEntries } from "./ui/fileEntries.js";
export type { FileEntrySortMode } from "./ui/fileEntries.js";
export {
  DEFAULT_FAVORITE_IGNORE_PATTERNS,
  classifyFavoritePath,
  collectFavoriteFiles,
} from "./ui/favoriteSelection.js";
export type { DocumentVersionRecord } from "./ui/browserClient.js";
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
  materializePersonalSpaceSettings,
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
export type {
  FavoriteExclusion,
  FavoritePathState,
} from "./ui/favoriteSelection.js";
export { downloadRemoteFile } from "./transfer/download.js";
export {
  createDuplexChannel,
  createStream,
} from "./transfer/frpBus.js";
export { createPortFromTransport } from "./transfer/frpTransport.js";
export type { DuplexChannel, Port, Stream } from "./transfer/frpBus.js";
export type { DuplexTransport } from "./transfer/frpTransport.js";
export {
  createCheckpointedDownloadSink,
  createPortDownloadSink,
  createSha256DownloadSink,
  RemoteMetadataChangedError,
  DownloadInterruptedError,
} from "./transfer/stream.js";
export type {
  DownloadCheckpoint,
  FileDownloadMetadata,
  FileDownloadResult,
  FileDownloadSink,
  FileTransferMessage,
} from "./transfer/stream.js";
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
export type {
  CachedFileDigest,
  CachedFileRecord,
  CachedFileStatus,
  ConnectOptions,
  ConnectionOverview,
  CreateSyncpeerBrowserClientOptions,
  FavoriteRecord,
  IdentityRecoveryExportResponse,
  LocalDiscoveredDevice,
  RemoteFsLike,
  SyncpeerBrowserClient,
  SyncpeerIdentityRecord,
  SyncpeerPlatformAdapter,
  UiLogEntry,
} from "./ui/browserClient.js";
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
export type { FolderIndexPollAttempt, ReadDirAttempt } from "./ui/sessionFlows.js";
export { createReplicaController } from "./sync/replicaControl.js";
export type { ReplicaState } from "./sync/replicaControl.js";
