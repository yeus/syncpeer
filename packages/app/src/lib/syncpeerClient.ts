import { createBrowserSyncpeerClient } from '@syncpeer/core/browser';
import type { FileEntry, FolderInfo, RemoteDeviceInfo } from '@syncpeer/core/browser';

export interface ConnectOptions {
  host: string;
  port: number;
  cert?: string;
  key?: string;
  remoteId?: string;
  deviceName: string;
  timeoutMs?: number;
}

export interface RemoteFsLike {
  listFolders: () => Promise<FolderInfo[]>;
  readDir: (folderId: string, path: string) => Promise<FileEntry[]>;
}

export interface ConnectionOverview {
  folders: FolderInfo[];
  device: RemoteDeviceInfo | null;
}

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const logUi = (event: string, details?: Record<string, unknown>) => {
  if (details) {
    console.log(`[syncpeer-ui] ${event}`, details);
    return;
  }
  console.log(`[syncpeer-ui] ${event}`);
};

const resolveInvoke = (): InvokeFn => {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    throw new Error('Tauri runtime is unavailable. Launch this app through Tauri (npm run dev -w @syncpeer/tauri-shell).');
  }
  return internals.invoke as InvokeFn;
};

const tryForwardUiErrorToCli = async (
  invoke: InvokeFn,
  event: string,
  details: Record<string, unknown>,
): Promise<void> => {
  try {
    await invoke<void>('syncpeer_log_ui_error', { event, details });
  } catch {
    // Ignore forwarding failures to avoid masking the original UI error.
  }
};

const normalizeConnectOptions = (options: ConnectOptions): ConnectOptions => ({
  host: options.host,
  port: options.port,
  cert: options.cert && options.cert.trim() !== '' ? options.cert : undefined,
  key: options.key && options.key.trim() !== '' ? options.key : undefined,
  remoteId: options.remoteId && options.remoteId.trim() !== '' ? options.remoteId : undefined,
  deviceName: options.deviceName,
  timeoutMs: options.timeoutMs,
});

const createLoggedInvoke = (invoke: InvokeFn): InvokeFn => {
  return async <T>(command: string, args?: Record<string, unknown>) => {
    const startedAt = Date.now();
    logUi('tauri.invoke.start', { command, args });
    try {
      const result = await invoke<T>(command, args);
      logUi('tauri.invoke.success', { command, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      console.error(`[syncpeer-ui] tauri.invoke.error ${command}`, error);
      const message = error instanceof Error ? error.message : String(error);
      void tryForwardUiErrorToCli(invoke, 'tauri.invoke.error', { command, args, message });
      throw error;
    }
  };
};

export const reportUiError = (event: string, error: unknown, context?: Record<string, unknown>) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[syncpeer-ui] ${event}`, { message, ...context });
  try {
    const invoke = resolveInvoke();
    void tryForwardUiErrorToCli(invoke, event, { message, ...context });
  } catch {
    // App might be running outside Tauri.
  }
};

const createTauriRemoteFs = (invoke: InvokeFn, options: ConnectOptions): RemoteFsLike => ({
  listFolders: () => invoke<FolderInfo[]>('syncpeer_connect_and_list_folders', { request: options }),
  readDir: (folderId: string, path: string) =>
    invoke<FileEntry[]>('syncpeer_read_remote_dir', { request: { ...options, folderId, path } }),
});

export const createSyncpeerUiClient = () => {
  const invoke = createLoggedInvoke(resolveInvoke());
  const browserClient = createBrowserSyncpeerClient<ConnectOptions, RemoteFsLike>({
    connectAndSync: async (options: ConnectOptions) => {
      const normalized = normalizeConnectOptions(options);
      logUi('connect.prepare', normalized);
      return createTauriRemoteFs(invoke, normalized);
    },
  });
  return {
    ...browserClient,
    connectAndGetOverview: async (options: ConnectOptions): Promise<ConnectionOverview> => {
      const normalized = normalizeConnectOptions(options);
      return invoke<ConnectionOverview>('syncpeer_connect_and_get_overview', { request: normalized });
    },
  };
};
