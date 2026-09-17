export interface PairingInvitation {
  format: 1;
  deviceId: string;
  endpoint: string;
  expiresAt: number;
  nonce: string;
  publicKey: string;
}

export interface PairingRequest {
  format: 1;
  deviceId: string;
  nonce: string;
  publicKey: string;
}

export interface PairingTransfer {
  nonce: string;
  ciphertext: string;
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const context = (invitation: PairingInvitation, request: PairingRequest) =>
  new TextEncoder().encode(`syncpeer.owned-pairing.v1\n${JSON.stringify([invitation, request])}`);
const validDeviceId = (value: string) => typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/.test(value);
const keyPair = async (subtle: SubtleCrypto) => subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);

export async function createPairingInvitation(subtle: SubtleCrypto,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>, deviceId: string,
  endpoint: string, expiresAt: number) {
  if (!validDeviceId(deviceId) || !endpoint || endpoint.length > 1024 ||
    !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 600_000) {
    throw new Error("Invalid pairing invitation.");
  }
  const pair = await keyPair(subtle), nonce = await randomBytes(16);
  if (nonce.length !== 16) throw new Error("Invalid pairing random source.");
  return { privateKey: pair.privateKey, invitation: { format: 1 as const, deviceId, endpoint, expiresAt,
    nonce: encode(nonce), publicKey: encode(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))) } };
}

export async function createPairingRequest(subtle: SubtleCrypto,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>, invitation: PairingInvitation,
  deviceId: string, verifiedRemoteId: string) {
  if (invitation.deviceId !== verifiedRemoteId || invitation.expiresAt <= Date.now() ||
    !validDeviceId(deviceId) || deviceId === verifiedRemoteId) throw new Error("Pairing identity mismatch or expired invitation.");
  const pair = await keyPair(subtle), nonce = await randomBytes(16);
  if (nonce.length !== 16) throw new Error("Invalid pairing random source.");
  return { privateKey: pair.privateKey, request: { format: 1 as const, deviceId, nonce: encode(nonce),
    publicKey: encode(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))) } };
}

/** The transport must supply the peer ID from its verified TLS certificate. */
export async function openPairingSession(subtle: SubtleCrypto, privateKey: CryptoKey,
  invitation: PairingInvitation, request: PairingRequest, verifiedRemoteId: string) {
  if (invitation.format !== 1 || request.format !== 1 || invitation.expiresAt <= Date.now() ||
    !validDeviceId(invitation.deviceId) || !validDeviceId(request.deviceId) ||
    invitation.deviceId === request.deviceId ||
    (verifiedRemoteId !== invitation.deviceId && verifiedRemoteId !== request.deviceId)) {
    throw new Error("Pairing identity mismatch or expired invitation.");
  }
  const remote = verifiedRemoteId === invitation.deviceId ? invitation.publicKey : request.publicKey;
  const publicKey = await subtle.importKey("raw", decode(remote), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
  const transcript = context(invitation, request);
  try {
    const input = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const key = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256",
      salt: new Uint8Array([...decode(invitation.nonce), ...decode(request.nonce)]), info: transcript }, input, 256));
    const codeHash = new Uint8Array(await subtle.digest("SHA-256", new Uint8Array([...key, ...transcript])));
    const code = new DataView(codeHash.buffer).getUint32(0) % 1_000_000;
    return { key, confirmationCode: code.toString().padStart(6, "0"), transcript };
  } finally { shared.fill(0); }
}

export async function sealPairingTransfer(subtle: SubtleCrypto,
  session: Awaited<ReturnType<typeof openPairingSession>>,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>,
  value: { spaceId: string; settingsFolderId: string; rootKey: string }): Promise<PairingTransfer> {
  if (!/^[a-f0-9]{32}$/.test(value.spaceId) || !/^[a-f0-9]{32}$/.test(value.settingsFolderId) ||
    !/^[a-f0-9]{64}$/.test(value.rootKey)) throw new Error("Invalid pairing transfer.");
  const nonce = await randomBytes(12);
  if (nonce.length !== 12) throw new Error("Invalid pairing random source.");
  const key = await subtle.importKey("raw", session.key, "AES-GCM", false, ["encrypt"]);
  const authenticated = new Uint8Array([...session.transcript, ...new TextEncoder().encode(session.confirmationCode)]);
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: authenticated }, key,
    new TextEncoder().encode(JSON.stringify(value)));
  return { nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
}

export async function openPairingTransfer(subtle: SubtleCrypto,
  session: Awaited<ReturnType<typeof openPairingSession>>, transfer: PairingTransfer) {
  const key = await subtle.importKey("raw", session.key, "AES-GCM", false, ["decrypt"]);
  const authenticated = new Uint8Array([...session.transcript, ...new TextEncoder().encode(session.confirmationCode)]);
  try {
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: decode(transfer.nonce),
      additionalData: authenticated }, key, decode(transfer.ciphertext));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    if (!value || typeof value !== "object" || !/^[a-f0-9]{32}$/.test((value as { spaceId?: string }).spaceId ?? "") ||
      !/^[a-f0-9]{32}$/.test((value as { settingsFolderId?: string }).settingsFolderId ?? "") ||
      !/^[a-f0-9]{64}$/.test((value as { rootKey?: string }).rootKey ?? "")) throw new Error("Invalid pairing transfer.");
    return value as { spaceId: string; settingsFolderId: string; rootKey: string };
  } catch { throw new Error("Pairing confirmation or encrypted transfer failed."); }
}
