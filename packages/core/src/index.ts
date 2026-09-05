export { createSyncpeerCoreClient, UploadOutcomeUnknownError, withMetadataSession } from "./client.js";
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
  SyncpeerTlsSocket,
} from "./client.js";
export {
  createNodeHostAdapter,
  createNodeSessionTransport,
  createNodeSyncpeerClient,
  resolveNodeLocalDiscovery,
} from "./node.js";
export { isTransportFailure, RemoteFs } from "./core/model/remoteFs.js";
export type { FolderInfo, FileEntry, FileBlock, RemoteDeviceInfo, FolderSyncState } from "./core/model/remoteFs.js";
export { createSyncpeerSessionStore } from "./ui/sessionStore.js";
export { createConnectionLifecycle, retryDelayMs } from "./ui/connectionLifecycle.js";
export type { ConnectionLifecycle, ConnectionLifecyclePhase, ConnectionLifecycleState } from "./ui/connectionLifecycle.js";
export { downloadRemoteFile } from "./transfer/download.js";
export type { DownloadRange, RangeDigest, CachedRangeStorage } from "./transfer/blockReuse.js";
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
