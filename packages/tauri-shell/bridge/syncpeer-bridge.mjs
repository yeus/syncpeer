import process from 'node:process';
import { connectAndSync } from '../../core/dist/index.js';
import { ensureCliNodeIdentity } from '../../cli/dist/identity.js';

const logBridge = (event, details) => {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  process.stderr.write(`[syncpeer-bridge] ${new Date().toISOString()} ${event}${suffix}\n`);
};

const parseJson = (raw) => {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${String(error)}`);
  }
};

const withTimeout = async (promise, timeoutMs) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Connection timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
};

const normalizeConnectOptions = (payload) => ({
  host: String(payload.host ?? '127.0.0.1'),
  port: Number(payload.port ?? 22000),
  discoveryMode: payload.discoveryMode === 'direct' ? 'direct' : 'global',
  discoveryServer: payload.discoveryServer ? String(payload.discoveryServer) : 'https://discovery.syncthing.net/v2/',
  cert: payload.cert ? String(payload.cert) : undefined,
  key: payload.key ? String(payload.key) : undefined,
  expectedDeviceId: payload.remoteId ? String(payload.remoteId) : undefined,
  deviceName: String(payload.deviceName ?? 'syncpeer-ui'),
  timeoutMs: Number(payload.timeoutMs ?? 15000),
});

const normalizeDiscoveryServerUrl = (rawUrl) => {
  const raw = (rawUrl ?? '').trim();
  const defaultUrl = 'https://discovery.syncthing.net/v2/';
  const withScheme = raw === '' ? defaultUrl : raw.includes('://') ? raw : `https://${raw}`;
  const base = new URL(withScheme);
  if (base.pathname === '/' || base.pathname === '') {
    base.pathname = '/v2/';
  }
  if (!base.pathname.endsWith('/')) {
    base.pathname = `${base.pathname}/`;
  }
  return base;
};

const parseDiscoveryAddress = (address) => {
  if (typeof address !== 'string' || address.trim() === '') return null;
  const value = address.trim();
  if (value.startsWith('tcp://')) {
    const parsed = new URL(value);
    if (!parsed.hostname || !parsed.port) return null;
    return { host: parsed.hostname, port: Number(parsed.port) };
  }
  return null;
};

const extractErrorMessage = (error) => {
  if (!error) return 'unknown error';
  if (error instanceof Error) {
    const cause = error.cause;
    const causeMessage =
      cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : null;
    return causeMessage ? `${error.message} (cause: ${causeMessage})` : error.message;
  }
  return String(error);
};

const resolveHostPortFromGlobalDiscovery = async (options) => {
  if (!options.expectedDeviceId) {
    throw new Error('Remote Device ID is required when discovery mode is global.');
  }
  const server = normalizeDiscoveryServerUrl(options.discoveryServer);
  server.searchParams.set('device', options.expectedDeviceId);
  logBridge('discovery.query.start', { server: server.toString() });
  let response;
  try {
    response = await fetch(server, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw new Error(
      `Global discovery request failed for ${server.toString()}: ${extractErrorMessage(error)}`,
    );
  }
  if (response.status === 404) {
    throw new Error(`Global discovery did not find device ${options.expectedDeviceId}.`);
  }
  if (!response.ok) {
    throw new Error(`Global discovery failed (${response.status}): ${await response.text()}`);
  }
  const payload = await response.json();
  const addresses = Array.isArray(payload.addresses) ? payload.addresses : [];
  const resolved = addresses.map(parseDiscoveryAddress).find((entry) => entry !== null) ?? null;
  if (!resolved) {
    throw new Error(
      `Global discovery returned no supported tcp:// addresses for device ${options.expectedDeviceId}.`,
    );
  }
  logBridge('discovery.query.success', {
    deviceId: options.expectedDeviceId,
    addressCount: addresses.length,
    selectedHost: resolved.host,
    selectedPort: resolved.port,
  });
  return resolved;
};

const resolveIdentityBackedConnectOptions = (opts) => {
  if (!opts.cert && !opts.key) {
    const identity = ensureCliNodeIdentity();
    logBridge('identity.auto_resolved', { configDir: identity.configDir, deviceId: identity.deviceId });
    return { ...opts, cert: identity.cert, key: identity.key };
  }
  return opts;
};

const requireCertAndKey = (opts) => {
  if (!opts.cert || !opts.key) {
    throw new Error('Both cert and key are required for Tauri bridge connections.');
  }
  return opts;
};

const openRemoteFs = async (payload) => {
  const options = requireCertAndKey(resolveIdentityBackedConnectOptions(normalizeConnectOptions(payload)));
  let resolvedConnection = { host: options.host, port: options.port };
  if (options.discoveryMode === 'global') {
    try {
      resolvedConnection = await resolveHostPortFromGlobalDiscovery(options);
    } catch (error) {
      logBridge('discovery.query.failed', {
        message: extractErrorMessage(error),
        fallbackHost: options.host,
        fallbackPort: options.port,
      });
      if (options.host && Number.isFinite(options.port) && options.port > 0) {
        logBridge('discovery.query.fallback_to_direct', {
          host: options.host,
          port: options.port,
          expectedDeviceId: options.expectedDeviceId ?? null,
        });
        resolvedConnection = { host: options.host, port: options.port };
      } else {
        throw error;
      }
    }
  }
  logBridge('connect.start', {
    host: resolvedConnection.host,
    port: resolvedConnection.port,
    expectedDeviceId: options.expectedDeviceId ?? null,
    deviceName: options.deviceName,
    discoveryMode: options.discoveryMode,
    timeoutMs: options.timeoutMs,
  });
  const startedAt = Date.now();
  const remoteFs = await withTimeout(
    connectAndSync({
      host: resolvedConnection.host,
      port: resolvedConnection.port,
      cert: options.cert,
      key: options.key,
      expectedDeviceId: options.expectedDeviceId,
      deviceName: options.deviceName,
    }),
    options.timeoutMs,
  );
  logBridge('connect.success', { durationMs: Date.now() - startedAt });
  return remoteFs;
};

const connectAndListFolders = async (payload) => {
  const remoteFs = await openRemoteFs(payload);
  try {
    logBridge('folders.list.start');
    const folders = await remoteFs.listFolders();
    logBridge('folders.list.success', { count: folders.length });
    return folders;
  } finally {
    remoteFs.close?.();
  }
};

const connectAndGetOverview = async (payload) => {
  const remoteFs = await openRemoteFs(payload);
  try {
    logBridge('overview.fetch.start');
    const [folders, device, folderSyncStates] = await Promise.all([
      remoteFs.listFolders(),
      Promise.resolve(remoteFs.getRemoteDeviceInfo?.() ?? null),
      Promise.resolve(remoteFs.listFolderSyncStates?.() ?? []),
    ]);
    logBridge('overview.fetch.success', { folderCount: folders.length, hasDevice: !!device });
    return { folders, device, folderSyncStates };
  } finally {
    remoteFs.close?.();
  }
};

const connectAndGetFolderVersions = async (payload) => {
  const remoteFs = await openRemoteFs(payload);
  try {
    logBridge('folder_versions.fetch.start');
    const folderSyncStates = await Promise.resolve(remoteFs.listFolderSyncStates?.() ?? []);
    logBridge('folder_versions.fetch.success', { count: folderSyncStates.length });
    return folderSyncStates;
  } finally {
    remoteFs.close?.();
  }
};

const readRemoteDir = async (payload) => {
  const remoteFs = await openRemoteFs(payload);
  try {
    const folderId = String(payload.folderId ?? '');
    const dirPath = String(payload.path ?? '');
    if (!folderId) throw new Error('folderId is required.');
    const requestedTimeout = Number(payload.timeoutMs ?? 3000);
    const waitForIndexMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, 20000)
      : 3000;
    logBridge('dir.read.start', { folderId, path: dirPath });
    const startedAt = Date.now();
    let attempts = 0;
    let indexed = false;
    let entries = [];

    do {
      attempts += 1;
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, waitForIndexMs - elapsedMs);
      if (typeof remoteFs.waitForFolderIndex === 'function' && !indexed) {
        indexed = await remoteFs.waitForFolderIndex(folderId, Math.min(1000, remainingMs));
      }
      entries = await remoteFs.readDir(folderId, dirPath);
      if (entries.length > 0) break;
      if (dirPath !== '') break;
      if (remainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (true);

    logBridge('dir.read.index_status', {
      folderId,
      indexed,
      waitForIndexMs,
      waitedMs: Date.now() - startedAt,
      attempts,
    });
    logBridge('dir.read.success', { folderId, path: dirPath, count: entries.length });
    return entries;
  } finally {
    remoteFs.close?.();
  }
};

const readRemoteFile = async (payload) => {
  const remoteFs = await openRemoteFs(payload);
  try {
    const folderId = String(payload.folderId ?? '');
    const filePath = String(payload.path ?? '');
    if (!folderId) throw new Error('folderId is required.');
    if (!filePath) throw new Error('path is required.');
    logBridge('file.read.start', { folderId, path: filePath });
    const bytes = await remoteFs.readFileFully(folderId, filePath);
    logBridge('file.read.success', { folderId, path: filePath, byteLength: bytes.length });
    return Array.from(bytes);
  } finally {
    remoteFs.close?.();
  }
};

const handlers = {
  connect_and_list_folders: connectAndListFolders,
  connect_and_get_overview: connectAndGetOverview,
  connect_and_get_folder_versions: connectAndGetFolderVersions,
  read_remote_dir: readRemoteDir,
  read_remote_file: readRemoteFile,
};

const main = async () => {
  const operation = process.argv[2];
  const payload = parseJson(process.argv[3]);
  logBridge('operation.start', { operation });
  const handler = handlers[operation];
  if (!handler) throw new Error(`Unsupported operation: ${operation ?? '(missing)'}`);
  const result = await handler(payload);
  logBridge('operation.success', { operation });
  process.stdout.write(JSON.stringify(result));
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logBridge('operation.error', { message });
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
