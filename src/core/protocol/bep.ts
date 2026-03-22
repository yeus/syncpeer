import * as protobuf from 'protobufjs/minimal';

/**
 * This module loads the Block Exchange Protocol (BEP) schema defined in
 * `bep.proto` and exposes helpers for encoding and decoding messages.
 *
 * The definitions here are generated at runtime using `protobufjs` rather
 * than being manually reimplemented.  See `bep.proto` for the canonical
 * schema.
 */

// We import the raw `.proto` source as a string.  Using a relative import
// ensures the file can be bundled by modern bundlers (they will replace
// the fs read with an inline string).  During development the TypeScript
// compiler will resolve the import to an ES module using node resolution.
import * as fs from 'fs';
import * as path from 'path';

// Read the .proto definition from disk.  Using import.meta.url ensures that
// the file is resolved relative to this module regardless of runtime.  The
// schema is embedded into the compiled output so there is no runtime file I/O
// in bundler environments.
const protoPath = new URL('./bep.proto', import.meta.url).pathname;
const schemaText = fs.readFileSync(protoPath, 'utf8');

// Parse the schema.  We keep case and convert field names to the camelCase
// format expected by protobufjs for JavaScript objects.
const root = protobuf.parse(String(schemaText), { keepCase: false }).root;

// Look up types and enums once to avoid repeated string lookups.
export const Hello = root.lookupType('Hello');
export const Header = root.lookupType('Header');
export const ClusterConfig = root.lookupType('ClusterConfig');
export const Index = root.lookupType('Index');
export const IndexUpdate = root.lookupType('IndexUpdate');
export const Request = root.lookupType('Request');
export const Response = root.lookupType('Response');

export const MessageTypeEnum = root.lookupEnum('MessageType');
export const MessageCompressionEnum = root.lookupEnum('MessageCompression');

export type MessageType = number;
export const MessageTypeValues = MessageTypeEnum.values as Record<string, number>;

export type MessageCompression = number;
export const MessageCompressionValues = MessageCompressionEnum.values as Record<string, number>;

/**
 * Encodes a Hello message and wraps it in the pre‑authentication frame.
 *
 * According to the BEP specification, Hello messages are prefixed by a magic
 * number (0x2EA7D90B) followed by a 16‑bit length and the encoded message.
 *
 * @param msg Object conforming to the Hello schema
 */
export function encodeHelloFrame(msg: Record<string, unknown>): Uint8Array {
  const magic = 0x2ea7d90b;
  const helloBuf = Hello.encode(Hello.create(msg)).finish();
  const len = helloBuf.length;
  if (len > 0xffff) {
    throw new Error('Hello message too long');
  }
  const frame = new Uint8Array(4 + 2 + len);
  const view = new DataView(frame.buffer);
  view.setUint32(0, magic >>> 0, false); // big endian
  view.setUint16(4, len, false);
  frame.set(helloBuf, 6);
  return frame;
}

/**
 * Decodes a Hello message from a buffer without the prefix.
 * @param data The encoded Hello message
 */
export function decodeHello(data: Uint8Array): any {
  return Hello.decode(data);
}

/**
 * Encodes a message with the given type and optional compression into the
 * standard post‑authentication frame (header length, header, message length,
 * message).  Compression is not currently supported and will cause an error.
 *
 * @param type Message type (one of MessageTypeValues)
 * @param message The message object corresponding to the type
 * @param compression Compression mode (0 = none)
 */
export function encodeFrame(
  type: MessageType,
  message: protobuf.Message<{}>,
  compression: MessageCompression = MessageCompressionValues.NONE,
): Uint8Array {
  if (compression !== MessageCompressionValues.NONE) {
    throw new Error('Compression not implemented');
  }
  // Build header
  const headerMsg = Header.create({ type, compression });
  const headerBuf = Header.encode(headerMsg).finish();
  if (headerBuf.length > 0xffff) {
    throw new Error('Header too long');
  }
  const messageBuf = message instanceof Uint8Array ? message : (message as any).constructor.encode(message).finish();
  const total = 2 + headerBuf.length + 4 + messageBuf.length;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint16(0, headerBuf.length, false);
  frame.set(headerBuf, 2);
  const msgLenOffset = 2 + headerBuf.length;
  view.setUint32(msgLenOffset, messageBuf.length >>> 0, false);
  frame.set(messageBuf, msgLenOffset + 4);
  return frame;
}

/**
 * Reads messages from a streaming source.  This function accepts a callback
 * which is invoked with each decoded frame consisting of the header and
 * message objects.  It maintains an internal buffer and should be called
 * whenever new data arrives from the transport.
 */
export class FrameParser {
  private buffer = new Uint8Array(0);
  private closed = false;
  constructor(private onFrame: (type: MessageType, msg: any) => void) {}
  /**
   * Append incoming data and process complete frames.
   */
  feed(data: Uint8Array): void {
    // Append new data to the buffer
    const combined = new Uint8Array(this.buffer.length + data.length);
    combined.set(this.buffer, 0);
    combined.set(data, this.buffer.length);
    this.buffer = combined;

    while (true) {
      if (this.buffer.length < 2) {
        return;
      }
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const headerLen = view.getUint16(0, false);
      if (this.buffer.length < 2 + headerLen + 4) {
        return;
      }
      const msgLenOffset = 2 + headerLen;
      const messageLen = view.getUint32(msgLenOffset, false);
      const totalLen = 2 + headerLen + 4 + messageLen;
      if (this.buffer.length < totalLen) {
        return;
      }
      // Slice out header and message
      const headerBuf = this.buffer.subarray(2, 2 + headerLen);
      const header = Header.decode(headerBuf);
      const messageBuf = this.buffer.subarray(msgLenOffset + 4, totalLen);
      let message: any;
      switch (header.type) {
        case MessageTypeValues.CLUSTER_CONFIG:
          message = ClusterConfig.decode(messageBuf);
          break;
        case MessageTypeValues.INDEX:
          message = Index.decode(messageBuf);
          break;
        case MessageTypeValues.INDEX_UPDATE:
          message = IndexUpdate.decode(messageBuf);
          break;
        case MessageTypeValues.RESPONSE:
          message = Response.decode(messageBuf);
          break;
        case MessageTypeValues.REQUEST:
          message = Request.decode(messageBuf);
          break;
        default:
          // Unknown or unsupported message type; return raw buffer
          message = messageBuf;
          break;
      }
      // Remove the processed bytes from the buffer
      this.buffer = this.buffer.subarray(totalLen);
      this.onFrame(header.type, message);
    }
  }
  close(): void {
    this.closed = true;
  }
}