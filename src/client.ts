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
import { RemoteFs } from './core/model/remoteFs.js';

/**
 * Internal representation of a folder received from the peer.  Contains
 * metadata from ClusterConfig and all FileInfo records from Index/IndexUpdate
 * messages.
 */
interface FolderState {
  id: string;
  label: string;
  readOnly: boolean;
  files: Map<string, any>; // FileInfo messages keyed by relative path
}

/**
 * Context for a BEP session.  Maintains the socket, parses frames, handles
 * request/response correlation and builds an in‑memory file index.
 */
class BepSession {
  private parser: FrameParser;
  private pending: Map<number, { resolve: (data: Uint8Array) => void; reject: (err: Error) => void }> = new Map();
  private nextId = 1;
  private folders: Map<string, FolderState> = new Map();
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private closed = false;
  constructor(private socket: tls.TLSSocket) {
    this.parser = new FrameParser((type, msg) => this.onFrame(type, msg));
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.setupListeners();
  }
  private setupListeners() {
    this.socket.on('data', (chunk: Buffer) => {
      // Pass post‑auth traffic to the frame parser
      this.parser.feed(new Uint8Array(chunk));
    });
    this.socket.on('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error('Connection closed'));
      }
      this.pending.clear();
    });
    this.socket.on('error', (err) => {
      // Errors are propagated to pending requests
      for (const { reject } of this.pending.values()) {
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
        // Unknown or unsupported message types are ignored for now
        break;
    }
  }
  private handleClusterConfig(cfg: any) {
    // Build folder states from cluster config
    for (const folder of cfg.folders || []) {
      const state: FolderState = {
        id: folder.id,
        label: folder.label || folder.id,
        readOnly: !!folder.read_only || Number(folder.type ?? 0) === 2,
        files: new Map(),
      };
      this.folders.set(folder.id, state);
    }
    // We might already have received indexes before the cluster config (unlikely),
    // but once cluster config arrives we consider the session ready.
    this.readyResolve();
  }
  private handleIndex(index: any) {
    const folderId = index.folder;
    const state = this.folders.get(folderId);
    if (!state) {
      // Unknown folder; ignore
      return;
    }
    for (const file of index.files || []) {
      state.files.set(file.name, file);
    }
  }
  private handleResponse(resp: any) {
    const id = resp.id;
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    if (resp.code && resp.code !== 0) {
      entry.reject(new Error(`Response error code ${resp.code}`));
    } else {
      entry.resolve(resp.data as Uint8Array);
    }
  }
  /**
   * Wait until the ClusterConfig has been received and folders initialised.
   */
  async waitForReady(): Promise<void> {
    return this.readyPromise;
  }
  /**
   * Send a post‑authentication frame.  This method writes directly to the
   * underlying socket.
   */
  private sendFrame(frame: Uint8Array): void {
    const buf = Buffer.from(frame);
    this.socket.write(buf);
  }
  /**
   * Send a cluster config to the peer.  The client uses this to announce its
   * folders and compression preferences.  To keep things simple we send an
   * empty list and request no compression.
   */
  sendClusterConfig(): void {
    const frame = encodeMessageFrame(MessageTypeValues.CLUSTER_CONFIG, ClusterConfig, { folders: [] }, 0);
    this.sendFrame(frame);
  }
  /**
   * Request a block from the peer.  The returned promise resolves with the
   * raw bytes contained in the corresponding Response message.  The request
   * identifier is managed automatically.
   */
  requestBlock(folder: string, name: string, offset: number, size: number): Promise<Uint8Array> {
    if (this.closed) {
      return Promise.reject(new Error('Connection closed'));
    }
    const id = this.nextId++;
    const frame = encodeMessageFrame(MessageTypeValues.REQUEST, Request, {
      id,
      folder,
      name,
      offset,
      size,
      hash: new Uint8Array(0),
      from_temporary: false,
    }, 0);
    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sendFrame(frame);
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }
  /**
   * Build a RemoteFs backed by this session.  The RemoteFs instance exposes
   * convenient file system‑like operations on the remote index.
   */
  buildRemoteFs(): RemoteFs {
    return new RemoteFs(this.folders, (folder, name, offset, size) => this.requestBlock(folder, name, offset, size));
  }
}

/**
 * Read the remote Hello message from the socket.  This must be performed
 * before parsing any post‑authentication frames.  Returns the parsed Hello
 * object and any bytes remaining in the socket buffer after the hello.
 */
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
      if (gotMagic !== magic) {
        throw new Error(`Invalid hello magic ${gotMagic.toString(16)}`);
      }
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

/**
 * Establish a connection to a Syncthing peer, perform the BEP handshake and
 * build an initial file index.  Returns a RemoteFs instance once the
 * ClusterConfig has been processed.  The returned RemoteFs is backed by a
 * live connection and can be used to list folders, read directories and
 * download files.
 */
export async function connectAndSync(opts: NodeTransportOptions & {
  deviceName: string;
  clientName?: string;
  clientVersion?: string;
}): Promise<RemoteFs> {
  const socket = await connectTLS(opts);
  // Send our hello immediately
  const helloFrame = encodeHelloFrame({
    device_name: opts.deviceName,
    client_name: opts.clientName ?? 'syncpeer',
    client_version: opts.clientVersion ?? '0.1.0',
  });
  socket.write(Buffer.from(helloFrame));
  // Read the remote hello
  const { hello: remoteHello, leftover } = await readRemoteHello(socket);
  // If there was leftover data after the hello, feed it to the parser later
  const session = new BepSession(socket);
  if (leftover && leftover.length > 0) {
    session['parser'].feed(leftover);
  }
  // Send our cluster config (empty) to request index data.  We request
  // uncompressed metadata by not setting compression on our device entry.
  session.sendClusterConfig();
  // Wait for cluster config from remote
  await session.waitForReady();
  // Build remote FS
  return session.buildRemoteFs();
}
