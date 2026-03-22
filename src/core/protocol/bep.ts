import fs from "node:fs";
import protobuf from "protobufjs";

const schemaText = fs.readFileSync(new URL("./bep.proto", import.meta.url), "utf8");
const root = protobuf.parse(schemaText, { keepCase: true }).root;

export const Hello = root.lookupType("Hello");
export const Header = root.lookupType("Header");
export const ClusterConfig = root.lookupType("ClusterConfig");
export const Index = root.lookupType("Index");
export const IndexUpdate = root.lookupType("IndexUpdate");
export const Request = root.lookupType("Request");
export const Response = root.lookupType("Response");

export const MessageTypeEnum = root.lookupEnum("MessageType");
export const MessageCompressionEnum = root.lookupEnum("MessageCompression");

export type MessageType = number;
export type MessageCompression = number;

export const MessageTypeValues = MessageTypeEnum.values as Record<string, number>;
export const MessageCompressionValues = MessageCompressionEnum.values as Record<string, number>;

export interface DecodedHeader {
  type: MessageType;
  compression?: MessageCompression;
}

export function encodeHelloFrame(message: Record<string, unknown>): Uint8Array {
  const encoded = Hello.encode(Hello.create(message)).finish();
  if (encoded.length > 0xffff) {
    throw new Error("Hello frame too long");
  }

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

      const view = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength,
      );

      const headerLen = view.getUint16(0, false);
      if (this.buffer.length < 2 + headerLen + 4) return;

      const msgLenOffset = 2 + headerLen;
      const messageLen = view.getUint32(msgLenOffset, false);
      const totalLen = 2 + headerLen + 4 + messageLen;
      if (this.buffer.length < totalLen) return;

      const headerBuf = this.buffer.subarray(2, 2 + headerLen);
      const header = Header.decode(headerBuf) as unknown as DecodedHeader;

      const messageBuf = this.buffer.subarray(msgLenOffset + 4, totalLen);

      let message: unknown;
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
        case MessageTypeValues.REQUEST:
          message = Request.decode(messageBuf);
          break;
        case MessageTypeValues.RESPONSE:
          message = Response.decode(messageBuf);
          break;
        default:
          message = messageBuf;
          break;
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
  if (compression !== MessageCompressionValues.NONE) {
    throw new Error("LZ4-compressed messages are not implemented yet");
  }

  const headerBuf = Header.encode(Header.create({ type, compression })).finish();
  if (headerBuf.length > 0xffff) {
    throw new Error("Header too long");
  }

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
