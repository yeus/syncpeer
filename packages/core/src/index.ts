export { createSyncpeerCoreClient } from "./client.js";
export type {
  SyncpeerCoreClient,
  SyncpeerConnectOptions,
  DiscoveredCandidate,
  SyncpeerHostAdapter,
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
export { RemoteFs } from "./core/model/remoteFs.js";
export type { FolderInfo, FileEntry, FileBlock, RemoteDeviceInfo, FolderSyncState } from "./core/model/remoteFs.js";
export { createSyncpeerSessionStore } from "./ui/sessionStore.js";
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
