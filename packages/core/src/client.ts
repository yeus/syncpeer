import * as crypto from 'crypto';
import * as fs from 'fs';
import * as tls from 'tls';
import { connectTLS, NodeTransportOptions } from './core/transport/node.js';
import {
  encodeHelloFrame,
  encodeMessageFrame,
  FrameParser,
  MessageTypeValues,
  Hello,
  ClusterConfig,
  Request,
} from './core/protocol/bep.js';
import { RemoteDeviceInfo, RemoteFs } from './core/model/remoteFs.js';
import { computeDeviceId } from './core/transport/node.js';

function logClient(event: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  process.stderr.write(`[syncpeer-core.client] ${new Date().toISOString()} ${event}${suffix}\n`);
}

interface FolderState {
  id: string;
  label: string;
  readOnly: boolean;
  files: Map<string, any>;
}

class BepSession {
  private parser: FrameParser;
  private pending: Map<number, { resolve: (data: Uint8Array) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = new Map();
  private nextId = 1;
  private folders: Map<string, FolderState> = new Map();
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private closed = false;
  private echoedClusterConfig = false;
  constructor(
    private socket: tls.TLSSocket,
    private localDeviceId: Uint8Array,
    private localDeviceName: string,
  ) {
    this.parser = new FrameParser((type, msg) => this.onFrame(type, msg));
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.setupListeners();
  }
  private setupListeners() {
    this.socket.on('data', (chunk: Buffer) => {
      this.parser.feed(new Uint8Array(chunk));
    });
    this.socket.on('close', () => {
      logClient('socket.close');
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('Connection closed'));
      }
      this.pending.clear();
    });
    this.socket.on('error', (err) => {
      logClient('socket.error', { message: err.message });
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
    });
  }
  private onFrame(type: number, msg: any) {
    switch (type) {
      case MessageTypeValues.CLUSTER_CONFIG:
        this.handleClusterConfig(msg);
        break;
      case MessageTypeValues.INDEX:
      case MessageTypeValues.INDEX_UPDATE:
        this.handleIndex(msg);
        break;
      case MessageTypeValues.RESPONSE:
        this.handleResponse(msg);
        break;
      default:
        break;
    }
  }
  private handleClusterConfig(cfg: any) {
    logClient('cluster_config.received', { folders: (cfg.folders || []).length });
    for (const folder of cfg.folders || []) {
      const state: FolderState = {
        id: folder.id,
        label: folder.label || folder.id,
        readOnly: !!folder.read_only || Number(folder.type ?? 0) === 2,
        files: new Map(),
      };
      this.folders.set(folder.id, state);
    }
    if (!this.echoedClusterConfig) {
      this.echoedClusterConfig = true;
      const folders = (cfg.folders || []).map((folder: any) => {
        const devices = Array.isArray(folder.devices) ? [...folder.devices] : [];
        const hasLocal = devices.some((device: any) => bytesEqual(device.id, this.localDeviceId));
        if (!hasLocal) {
          devices.push({
            id: this.localDeviceId,
            name: this.localDeviceName,
            addresses: ['dynamic'],
            compression: 0,
            max_sequence: 0,
            index_id: 0,
          });
        }
        return {
          ...folder,
          devices,
        };
      });
      const frame = encodeMessageFrame(MessageTypeValues.CLUSTER_CONFIG, ClusterConfig, { folders }, 0);
      this.sendFrame(frame);
      logClient('cluster_config.echoed', { folders: folders.length });
    }
    this.readyResolve();
  }
  private handleIndex(index: any) {
    const folderId = index.folder;
    const state = this.folders.get(folderId);
    if (!state) return;
    for (const file of index.files || []) {
      state.files.set(file.name, file);
    }
  }
  private handleResponse(resp: any) {
    const id = resp.id;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (resp.code && resp.code !== 0) {
      entry.reject(new Error(`Response error code ${resp.code}`));
    } else {
      entry.resolve(resp.data as Uint8Array);
    }
  }
  async waitForReady(): Promise<void> {
    return this.readyPromise;
  }
  private sendFrame(frame: Uint8Array): void {
    this.socket.write(Buffer.from(frame));
  }
  requestBlock(folder: string, name: string, offset: number, size: number): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    const id = this.nextId++;
    const frame = encodeMessageFrame(MessageTypeValues.REQUEST, Request, {
      id, folder, name, offset, size, hash: new Uint8Array(0), from_temporary: false,
    }, 0);
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout for ${name} at offset ${offset}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendFrame(frame);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }
  buildRemoteFs(): RemoteFs {
    return new RemoteFs(this.folders, (folder, name, offset, size) => this.requestBlock(folder, name, offset, size));
  }
  buildRemoteFsWithMetadata(metadata: RemoteDeviceInfo): RemoteFs {
    return new RemoteFs(
      this.folders,
      (folder, name, offset, size) => this.requestBlock(folder, name, offset, size),
      metadata,
    );
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function localDeviceIdFromCert(certInput: string | Buffer): Uint8Array {
  const certPem = typeof certInput === 'string' ? fs.readFileSync(certInput) : certInput;
  const cert = new crypto.X509Certificate(certPem);
  return new Uint8Array(crypto.createHash('sha256').update(cert.raw).digest());
}

async function readRemoteHello(socket: tls.TLSSocket): Promise<{ hello: any; leftover: Uint8Array }> {
  let buf = Buffer.alloc(0);
  const magic = 0x2ea7d90b;
  while (true) {
    const chunk: Buffer = await new Promise((resolve, reject) => {
      const onData = (data: Buffer) => {
        socket.off('error', onError);
        socket.off('data', onData);
        resolve(data);
      };
      const onError = (err: Error) => {
        socket.off('data', onData);
        socket.off('error', onError);
        reject(err);
      };
      socket.once('data', onData);
      socket.once('error', onError);
    });
    buf = Buffer.concat([buf, chunk]);
    if (buf.length >= 6) {
      const gotMagic = buf.readUInt32BE(0);
      if (gotMagic !== magic) throw new Error(`Invalid hello magic ${gotMagic.toString(16)}`);
      const len = buf.readUInt16BE(4);
      if (buf.length >= 6 + len) {
        const helloBuf = buf.slice(6, 6 + len);
        const leftover = buf.slice(6 + len);
        const hello = Hello.decode(new Uint8Array(helloBuf));
        return { hello, leftover: new Uint8Array(leftover) };
      }
    }
  }
}

export async function connectAndSync(opts: NodeTransportOptions & {
  deviceName: string;
  clientName?: string;
  clientVersion?: string;
}): Promise<RemoteFs> {
  logClient('connect.start', {
    host: opts.host,
    port: opts.port,
    deviceName: opts.deviceName,
    expectedDeviceId: opts.expectedDeviceId ?? null,
  });
  const socket = await connectTLS(opts);
  const localDeviceId = localDeviceIdFromCert(opts.cert);
  logClient('connect.local_device_id_ready', { byteLength: localDeviceId.length });
  const helloFrame = encodeHelloFrame({
    device_name: opts.deviceName,
    client_name: opts.clientName ?? 'syncpeer',
    client_version: opts.clientVersion ?? '0.1.0',
  });
  socket.write(Buffer.from(helloFrame));
  logClient('hello.sent');
  const { hello, leftover } = await readRemoteHello(socket);
  const peer = socket.getPeerCertificate(true);
  const deviceId = peer?.raw ? computeDeviceId(peer.raw) : 'unknown';
  const remoteDeviceInfo: RemoteDeviceInfo = {
    id: deviceId,
    deviceName: String(hello.device_name ?? 'unknown'),
    clientName: String(hello.client_name ?? 'unknown'),
    clientVersion: String(hello.client_version ?? 'unknown'),
  };
  logClient('hello.received', {
    deviceId: remoteDeviceInfo.id,
    deviceName: remoteDeviceInfo.deviceName,
    clientName: remoteDeviceInfo.clientName,
    clientVersion: remoteDeviceInfo.clientVersion,
    leftoverBytes: leftover.length,
  });
  const session = new BepSession(socket, localDeviceId, opts.deviceName);
  if (leftover && leftover.length > 0) {
    (session as any)['parser'].feed(leftover);
  }
  await session.waitForReady();
  logClient('connect.ready');
  return session.buildRemoteFsWithMetadata(remoteDeviceInfo);
}
