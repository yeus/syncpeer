import { createSyncpeerClient, type SyncpeerClient, type SyncpeerConnector } from './clientFactory.js';

export { RemoteFs } from './core/model/remoteFs.js';
export { createSyncpeerClient } from './clientFactory.js';
export type { FolderInfo, FileEntry, FileBlock, RemoteDeviceInfo, FolderSyncState } from './core/model/remoteFs.js';
export type { SyncpeerClient, SyncpeerConnector } from './clientFactory.js';

export const createBrowserSyncpeerClient = <ConnectOptions, ClientFs>(
  connector: SyncpeerConnector<ConnectOptions, ClientFs>,
): SyncpeerClient<ConnectOptions, ClientFs> => createSyncpeerClient(connector);

export async function connectAndSync(): Promise<never> {
  throw new Error(
    'connectAndSync is not available in browser builds. ' +
      'Inject a transport with createBrowserSyncpeerClient(...) and call the returned connectAndSync instead.',
  );
}
