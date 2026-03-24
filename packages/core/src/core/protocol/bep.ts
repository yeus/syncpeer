import fs from "node:fs";
import protobuf from "protobufjs";
import { decompressBlock } from "lz4js";

const schemaText = fs.readFileSync(new URL("./bep.proto", import.meta.url), "utf8");
const root = protobuf.parse(schemaText, { keepCase: true }).root;

function lookupTypeAny(...names: string[]) {
  for (const name of names) {
    try { return root.lookupType(name); } catch {}
  }
  throw new Error(`Type not found in BEP schema: ${names.join(", ")}`);
}
function lookupEnumAny(...names: string[]) {
  for (const name of names) {
    try { return root.lookupEnum(name); } catch {}
  }
  throw new Error(`Enum not found in BEP schema: ${names.join(", ")}`);
}

export const Hello = lookupTypeAny("Hello", "bep.Hello");
export const Header = lookupTypeAny("Header", "bep.Header");
export const ClusterConfig = lookupTypeAny("ClusterConfig", "bep.ClusterConfig");
export const Index = lookupTypeAny("Index", "bep.Index");
export const IndexUpdate = lookupTypeAny("IndexUpdate", "bep.IndexUpdate");
export const Request = lookupTypeAny("Request", "bep.Request");
export const Response = lookupTypeAny("Response", "bep.Response");
export const MessageTypeEnum = lookupEnumAny("MessageType", "bep.MessageType");
export const MessageCompressionEnum = lookupEnumAny("MessageCompression", "bep.MessageCompression");
export type MessageType = number;
export type MessageCompression = number;

const rawMessageTypeValues = MessageTypeEnum.values as Record<string, number>;
const rawCompressionValues = MessageCompressionEnum.values as Record<string, number>;

export const MessageTypeValues = {
  CLUSTER_CONFIG: rawMessageTypeValues.CLUSTER_CONFIG ?? rawMessageTypeValues.MESSAGE_TYPE_CLUSTER_CONFIG,
  INDEX: rawMessageTypeValues.INDEX ?? rawMessageTypeValues.MESSAGE_TYPE_INDEX,
  INDEX_UPDATE: rawMessageTypeValues.INDEX_UPDATE ?? rawMessageTypeValues.MESSAGE_TYPE_INDEX_UPDATE,
  REQUEST: rawMessageTypeValues.REQUEST ?? rawMessageTypeValues.MESSAGE_TYPE_REQUEST,
  RESPONSE: rawMessageTypeValues.RESPONSE ?? rawMessageTypeValues.MESSAGE_TYPE_RESPONSE,
  DOWNLOAD_PROGRESS: rawMessageTypeValues.DOWNLOAD_PROGRESS ?? rawMessageTypeValues.MESSAGE_TYPE_DOWNLOAD_PROGRESS,
  PING: rawMessageTypeValues.PING ?? rawMessageTypeValues.MESSAGE_TYPE_PING,
  CLOSE: rawMessageTypeValues.CLOSE ?? rawMessageTypeValues.MESSAGE_TYPE_CLOSE,
} as const;

export const MessageCompressionValues = {
  NONE: rawCompressionValues.NONE ?? rawCompressionValues.MESSAGE_COMPRESSION_NONE,
  LZ4: rawCompressionValues.LZ4 ?? rawCompressionValues.MESSAGE_COMPRESSION_LZ4,
} as const;

export interface DecodedHeader {
  type: MessageType;
  compression?: MessageCompression;
}

export function encodeHelloFrame(message: Record<string, unknown>): Uint8Array {
  const encoded = Hello.encode(Hello.create(message)).finish();
  if (encoded.length > 0xffff) throw new Error("Hello frame too long");
  const out = new Uint8Array(6 + encoded.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 0x2ea7d90b, false);
  view.setUint16(4, encoded.length, false);
  out.set(encoded, 6);
  return out;
}

export class FrameParser {
  private buffer = new Uint8Array(0);
  constructor(private onFrame: (type: MessageType, msg: unknown) => void) {}
  feed(data: Uint8Array): void {
    const combined = new Uint8Array(this.buffer.length + data.length);
    combined.set(this.buffer, 0);
    combined.set(data, this.buffer.length);
    this.buffer = combined;

    while (true) {
      if (this.buffer.length < 2) return;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const headerLen = view.getUint16(0, false);
      if (this.buffer.length < 2 + headerLen + 4) return;
      const msgLenOffset = 2 + headerLen;
      const messageLen = view.getUint32(msgLenOffset, false);
      const totalLen = 2 + headerLen + 4 + messageLen;
      if (this.buffer.length < totalLen) return;

      const headerBuf = this.buffer.subarray(2, 2 + headerLen);
      const header = Header.decode(headerBuf) as unknown as DecodedHeader;
      let messageBuf = this.buffer.subarray(msgLenOffset + 4, totalLen);
      const compression = Number((header as any).compression ?? MessageCompressionValues.NONE);
      if (compression === MessageCompressionValues.LZ4) {
        if (messageBuf.length < 4) throw new Error(`LZ4 message too short (${messageBuf.length})`);
        const view = new DataView(messageBuf.buffer, messageBuf.byteOffset, messageBuf.byteLength);
        const decompressedSize = view.getUint32(0, false);
        const decompressed = new Uint8Array(decompressedSize);
        const written = decompressBlock(messageBuf, decompressed, 4, messageBuf.length - 4, 0);
        messageBuf = decompressed.subarray(0, written);
      } else if (compression !== MessageCompressionValues.NONE) {
        throw new Error(`Unsupported message compression: ${compression}`);
      }

      let message: unknown;
      switch (header.type) {
        case MessageTypeValues.CLUSTER_CONFIG: message = ClusterConfig.decode(messageBuf); break;
        case MessageTypeValues.INDEX: message = Index.decode(messageBuf); break;
        case MessageTypeValues.INDEX_UPDATE: message = IndexUpdate.decode(messageBuf); break;
        case MessageTypeValues.REQUEST: message = Request.decode(messageBuf); break;
        case MessageTypeValues.RESPONSE: message = Response.decode(messageBuf); break;
        default: message = messageBuf; break;
      }

      this.buffer = this.buffer.subarray(totalLen);
      this.onFrame(header.type, message);
    }
  }
}

export function encodeMessageFrame(
  type: MessageType,
  messageType: protobuf.Type,
  payload: Record<string, unknown>,
  compression: MessageCompression = MessageCompressionValues.NONE,
): Uint8Array {
  if (compression !== MessageCompressionValues.NONE) throw new Error("LZ4-compressed messages are not implemented yet");
  const headerBuf = Header.encode(Header.create({ type, compression })).finish();
  if (headerBuf.length > 0xffff) throw new Error("Header too long");
  const messageBuf = messageType.encode(messageType.create(payload)).finish();
  const out = new Uint8Array(2 + headerBuf.length + 4 + messageBuf.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(0, headerBuf.length, false);
  out.set(headerBuf, 2);
  const msgOffset = 2 + headerBuf.length;
  view.setUint32(msgOffset, messageBuf.length, false);
  out.set(messageBuf, msgOffset + 4);
  return out;
}
