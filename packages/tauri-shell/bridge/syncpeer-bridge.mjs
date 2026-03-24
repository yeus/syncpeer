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
  cert: payload.cert ? String(payload.cert) : undefined,
  key: payload.key ? String(payload.key) : undefined,
  expectedDeviceId: payload.remoteId ? String(payload.remoteId) : undefined,
  deviceName: String(payload.deviceName ?? 'syncpeer-ui'),
  timeoutMs: Number(payload.timeoutMs ?? 15000),
});

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
  logBridge('connect.start', {
    host: options.host,
    port: options.port,
    expectedDeviceId: options.expectedDeviceId ?? null,
    deviceName: options.deviceName,
    timeoutMs: options.timeoutMs,
  });
  const startedAt = Date.now();
  const remoteFs = await withTimeout(
    connectAndSync({
      host: options.host,
      port: options.port,
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
    const [folders, device] = await Promise.all([
      remoteFs.listFolders(),
      Promise.resolve(remoteFs.getRemoteDeviceInfo?.() ?? null),
    ]);
    logBridge('overview.fetch.success', { folderCount: folders.length, hasDevice: !!device });
    return { folders, device };
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

const handlers = {
  connect_and_list_folders: connectAndListFolders,
  connect_and_get_overview: connectAndGetOverview,
  read_remote_dir: readRemoteDir,
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
