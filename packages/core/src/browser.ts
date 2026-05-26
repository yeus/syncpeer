export { createSyncpeerCoreClient } from "./client.js";
export type {
  SyncpeerCoreClient,
  SyncpeerConnectOptions,
  SyncpeerDiscoveryFetchInit,
  SyncpeerDiscoveryResponse,
  SyncpeerHostAdapter,
  SyncpeerSessionHandle,
  SyncpeerTlsConnectOptions,
  SyncpeerTlsSocket,
} from "./client.js";
export { RemoteFs } from "./core/model/remoteFs.js";
export type {
  AdvertisedDeviceInfo,
  FileBlock,
  FileDownloadProgress,
  FileEntry,
  FolderInfo,
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
export {
  makeReadDirWithRetryFlow,
  makeWaitForFolderIndexToArriveFlow,
  makeWaitForFoldersToPopulateFlow,
} from "./ui/sessionFlows.js";
export { resolvePreferredSourceDeviceId } from "./ui/sessionPolicies.js";
export type {
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
