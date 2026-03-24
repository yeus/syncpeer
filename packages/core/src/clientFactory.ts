export interface SyncpeerClient<ConnectOptions, ClientFs> {
  connectAndSync: (opts: ConnectOptions) => Promise<ClientFs>;
}

export interface SyncpeerConnector<ConnectOptions, ClientFs> {
  connectAndSync: (opts: ConnectOptions) => Promise<ClientFs>;
}

export const createSyncpeerClient = <ConnectOptions, ClientFs>(
  connector: SyncpeerConnector<ConnectOptions, ClientFs>,
): SyncpeerClient<ConnectOptions, ClientFs> => ({
  connectAndSync: (opts: ConnectOptions) => connector.connectAndSync(opts),
});
