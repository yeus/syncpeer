export { createSyncpeerCoreClient } from "./client.js";
export type {
  SyncpeerCoreClient,
  SyncpeerConnectOptions,
  ConnectionScope,
  DiscoveredCandidate,
  SyncpeerHostAdapter,
  SharedFolder,
  SyncpeerSessionHandle,
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
export { downloadRemoteFile } from "./transfer/download.js";
export { createDuplexChannel, createStream } from "./transfer/frpBus.js";
export { createPortFromTransport } from "./transfer/frpTransport.js";
export type { DuplexChannel, Port, Stream } from "./transfer/frpBus.js";
export type { DuplexTransport } from "./transfer/frpTransport.js";
export type {
  FileDownloadMetadata,
  FileDownloadResult,
  FileDownloadSink,
  FileTransferMessage,
} from "./transfer/stream.js";
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
