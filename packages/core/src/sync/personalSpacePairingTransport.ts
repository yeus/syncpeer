import type { SyncpeerTlsSocket } from "../client.js";
import { createPairingRequest, openPairingSession, openPairingTransfer,
  sealPairingTransfer, type PairingInvitation, type PairingRequest,
  type PairingTransfer, type PersonalSpacePairingTransfer } from "./personalSpacePairing.js";

const MAX_PAIRING_MESSAGE_BYTES = 64 * 1024;

type PairingMessage =
  | { format: 1; kind: "request"; request: PairingRequest }
  | { format: 1; kind: "confirmation"; accepted: boolean }
  | { format: 1; kind: "transfer"; transfer: PairingTransfer };

const createMessageReader = (socket: SyncpeerTlsSocket) => {
  let buffered = new Uint8Array();
  const readBytes = async (size: number) => {
    while (buffered.length < size) {
      const chunk = await socket.read(MAX_PAIRING_MESSAGE_BYTES + 4);
      if (!chunk.length || buffered.length + chunk.length > MAX_PAIRING_MESSAGE_BYTES + 4) {
        throw new Error("Invalid pairing message size.");
      }
      const combined = new Uint8Array(buffered.length + chunk.length);
      combined.set(buffered); combined.set(chunk, buffered.length); buffered = combined;
    }
    const value = buffered.slice(0, size);
    buffered = buffered.slice(size);
    return value;
  };
  return async (): Promise<PairingMessage> => {
    const header = await readBytes(4);
    const size = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
    if (!size || size > MAX_PAIRING_MESSAGE_BYTES) throw new Error("Invalid pairing message size.");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(size))); }
    catch { throw new Error("Invalid pairing message."); }
    if (!value || typeof value !== "object" || (value as { format?: unknown }).format !== 1) {
      throw new Error("Invalid pairing message.");
    }
    return value as PairingMessage;
  };
};

const writeMessage = async (socket: SyncpeerTlsSocket, message: PairingMessage) => {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  if (!payload.length || payload.length > MAX_PAIRING_MESSAGE_BYTES) throw new Error("Invalid pairing message size.");
  const frame = new Uint8Array(payload.length + 4);
  new DataView(frame.buffer).setUint32(0, payload.length, false);
  frame.set(payload, 4);
  await socket.write(frame);
};

const requireKind = <TKind extends PairingMessage["kind"]>(message: PairingMessage, kind: TKind) => {
  if (message.kind !== kind) throw new Error(`Expected pairing ${kind} message.`);
  return message as Extract<PairingMessage, { kind: TKind }>;
};

export async function acceptPairingTransfer(options: {
  subtle: SubtleCrypto;
  socket: SyncpeerTlsSocket;
  invitation: { privateKey: CryptoKey; invitation: PairingInvitation };
  verifiedRemoteId: string;
  createTransfer: (device: PairingRequest["device"]) => Promise<PersonalSpacePairingTransfer>;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
  confirm: (confirmationCode: string) => boolean | Promise<boolean>;
}) {
  const read = createMessageReader(options.socket);
  const request = requireKind(await read(), "request").request;
  const session = await openPairingSession(options.subtle, options.invitation.privateKey,
    options.invitation.invitation, request, options.verifiedRemoteId);
  const accepted = await options.confirm(session.confirmationCode);
  await writeMessage(options.socket, { format: 1, kind: "confirmation", accepted });
  const remoteAccepted = requireKind(await read(), "confirmation").accepted;
  if (!accepted || !remoteAccepted) throw new Error("Pairing confirmation was rejected.");
  const transfer = await sealPairingTransfer(options.subtle, session, options.randomBytes,
    await options.createTransfer(request.device));
  await writeMessage(options.socket, { format: 1, kind: "transfer", transfer });
  return { remoteDeviceId: request.deviceId, confirmationCode: session.confirmationCode };
}

export async function joinPersonalSpace(options: {
  subtle: SubtleCrypto;
  socket: SyncpeerTlsSocket;
  invitation: PairingInvitation;
  localDeviceId: string;
  verifiedRemoteId: string;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
  confirm: (confirmationCode: string) => boolean | Promise<boolean>;
}) {
  const created = await createPairingRequest(options.subtle, options.randomBytes,
    options.invitation, options.localDeviceId, options.verifiedRemoteId);
  const session = await openPairingSession(options.subtle, created.privateKey, options.invitation,
    created.request, options.verifiedRemoteId);
  const read = createMessageReader(options.socket);
  await writeMessage(options.socket, { format: 1, kind: "request", request: created.request });
  const accepted = await options.confirm(session.confirmationCode);
  await writeMessage(options.socket, { format: 1, kind: "confirmation", accepted });
  const remoteAccepted = requireKind(await read(), "confirmation").accepted;
  if (!accepted || !remoteAccepted) throw new Error("Pairing confirmation was rejected.");
  const transfer = requireKind(await read(), "transfer").transfer;
  return { transfer: await openPairingTransfer(options.subtle, session, transfer),
    deviceIdentity: created.deviceIdentity, confirmationCode: session.confirmationCode };
}
