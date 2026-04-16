export { createSyncpeerCoreClient } from "./client.ts";
export type {
  SyncpeerCoreClient,
  SyncpeerConnectOptions,
  SyncpeerDiscoveryFetchInit,
  SyncpeerDiscoveryResponse,
  SyncpeerHostAdapter,
  SyncpeerSessionHandle,
  SyncpeerTlsConnectOptions,
  SyncpeerTlsSocket,
} from "./client.ts";
export { RemoteFs } from "./core/model/remoteFs.ts";
export type {
  AdvertisedDeviceInfo,
  FileBlock,
  FileDownloadProgress,
  FileEntry,
  FolderInfo,
  FolderSyncState,
  RemoteDeviceInfo,
} from "./core/model/remoteFs.ts";
export {
  buildConnectionDetails,
  fromConnectionSettings,
  toConnectionSettings,
} from "./ui/connectionState.ts";
export type {
  DiscoveryMode,
  StoredConnectionSettingsLike,
} from "./ui/connectionState.ts";
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
} from "./ui/helpers.ts";
export {
  FOLDER_PASSWORD_SCOPE_SEPARATOR,
  folderPasswordScopedKey,
  isScopedFolderPasswordKey,
  resolveFolderPasswordsForDevice,
} from "./ui/sessionPasswords.ts";
export type {
  AdvertisedDeviceItem,
  AdvertisedFolderItem,
  BreadcrumbSegment,
  SavedDeviceLike,
} from "./ui/helpers.ts";
export {
  createSyncpeerBrowserClient,
  getDefaultDiscoveryServer,
  normalizeDiscoveryServer,
  reportClientError,
} from "./ui/browserClient.ts";
export { createSyncpeerSessionStore } from "./ui/sessionStore.ts";
export {
  makeReadDirWithRetryFlow,
  makeWaitForFolderIndexToArriveFlow,
  makeWaitForFoldersToPopulateFlow,
} from "./ui/sessionFlows.ts";
export { resolvePreferredSourceDeviceId } from "./ui/sessionPolicies.ts";
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
} from "./ui/browserClient.ts";
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
} from "./ui/sessionTypes.ts";
export type { FolderIndexPollAttempt, ReadDirAttempt } from "./ui/sessionFlows.ts";
