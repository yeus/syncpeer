import { connectAndSync } from './client.js';
import { createSyncpeerClient } from './clientFactory.js';

export { connectAndSync } from './client.js';
export { createSyncpeerClient } from './clientFactory.js';
export { RemoteFs } from './core/model/remoteFs.js';
export type { FolderInfo, FileEntry, FileBlock, RemoteDeviceInfo } from './core/model/remoteFs.js';
export type { NodeTransportOptions } from './core/transport/node.js';

export const createNodeSyncpeerClient = () => createSyncpeerClient({
  connectAndSync,
});
