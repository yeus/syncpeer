import { sha256 } from "@noble/hashes/sha2.js";
import type { BepFileInfo } from "../core/protocol/bep.js";
import { equalHash, validateBlockPlan } from "../transfer/blockReuse.js";
import type { LocalFolderReplica } from "./replicaIndex.js";
import { isInternalReplicaPath } from "./replicaPaths.js";
import { verifySpaceDeviceMembership, type SpaceDeviceMembershipTrust } from "./personalSpaceSharing.js";

export interface FolderManifestEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  /** Hex-encoded BEP symlink_target bytes; required for symlinks. */
  symlinkTarget?: string;
  size: number;
  deleted: boolean;
  version: readonly { id: string; value: string }[];
  blocks: readonly string[];
}

export interface FolderRetentionPolicy {
  format: 1;
  folderId: string;
  minimumCopies: number;
  revision: number;
  rosterHead: string;
  holders: readonly { id: string; kind: "syncpeer" | "syncthing" }[];
}

export interface ReplicaCompletion {
  format: 1;
  folderId: string;
  holderId: string;
  holderKind: "syncpeer" | "syncthing";
  signerId: string;
  manifestDigest: string;
  policyRevision: number;
  completedAtMs: number;
  liveUntilMs?: number;
  signature: string;
}

export interface RetentionReleaseProposal {
  format: 1;
  action: "release-local-copy";
  folderId: string;
  releaseHolderId: string;
  proposerId: string;
  policyRevision: number;
  rosterHead: string;
  manifestDigest: string;
  id: string;
  signature: string;
}

export interface DangerousLocalRelease {
  format: 1;
  scope: "local-copy-only";
  guaranteeBroken: true;
  folderId: string;
  localHolderId: string;
  policyRevision: number;
  rosterHead: string;
  manifestDigest: string;
  createdAtMs: number;
  signature: string;
}

const encoder = new TextEncoder();
const MAX_COMPLETION_AGE_MS = 5 * 60_000;
const text = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
};
const integer = (value: unknown, label: string, minimum = 0) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`Invalid ${label}.`);
  return Number(value);
};
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const digest = (bytes: Uint8Array) => hex(sha256(bytes));

const canonicalManifestEntry = (entry: FolderManifestEntry) => {
  const path = text(entry.path, "manifest path");
  if (path.startsWith("/") || path.endsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Invalid manifest path.");
  }
  if (!["file", "directory", "symlink"].includes(entry.type)) throw new Error("Invalid manifest entry type.");
  if (typeof entry.deleted !== "boolean" || !Array.isArray(entry.version) || !Array.isArray(entry.blocks)) {
    throw new Error("Invalid manifest entry.");
  }
  const symlinkTarget = entry.symlinkTarget;
  if (entry.type === "symlink" && !entry.deleted && !symlinkTarget ||
    symlinkTarget !== undefined && (entry.type !== "symlink" || symlinkTarget.length > 4096 ||
      !/^(?:[0-9a-f]{2})+$/i.test(symlinkTarget))) throw new Error("Invalid manifest symlink target.");
  const seen = new Set<string>();
  const version = entry.version.map(counter => {
    const id = String(BigInt(text(counter.id, "manifest version identifier")));
    const value = String(BigInt(text(counter.value, "manifest version value")));
    if (id.startsWith("-") || value.startsWith("-") || seen.has(id)) throw new Error("Invalid manifest version.");
    seen.add(id);
    return { id, value };
  }).sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0);
  return { path, type: entry.type, ...(symlinkTarget ? { symlinkTarget: symlinkTarget.toLowerCase() } : {}),
    size: integer(entry.size, "manifest size"), deleted: entry.deleted === true,
    version, blocks: entry.blocks.map(block => text(block, "manifest block hash")) };
};

/** Identifies the complete BEP-visible state, independent of local enumeration order. */
export function folderManifestDigest(entries: readonly FolderManifestEntry[]): string {
  const paths = new Set<string>();
  const canonical = entries.map(canonicalManifestEntry)
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const entry of canonical) {
    if (paths.has(entry.path)) throw new Error("Duplicate manifest path.");
    paths.add(entry.path);
  }
  return digest(encoder.encode(`syncpeer.folder-manifest.v1\n${JSON.stringify(canonical)}`));
}

/** Converts a complete BEP index to a digest; it does not prove the indexed bytes are stored. */
export function folderManifestDigestFromBep(files: readonly BepFileInfo[]): string {
  return folderManifestDigest(files.map(file => {
    const type = Number(file.type ?? 0);
    if (file.invalid || ![0, 1, 2, 3, 4].includes(type)) throw new Error("Invalid BEP manifest entry.");
    const blocks = file.blocks ?? file.Blocks ?? [];
    if (type === 0 && !file.deleted) validateBlockPlan(blocks, Number(file.size ?? 0));
    else if (blocks.length) throw new Error("Invalid BEP manifest block list.");
    const kind = type === 0 ? "file" : type === 1 ? "directory" : "symlink";
    return { path: file.name, type: kind, size: Number(file.size ?? 0), deleted: file.deleted === true,
      version: (file.version?.counters ?? []).map(counter => ({ id: String(counter.id), value: String(counter.value) })),
      blocks: blocks.map(block => hex(block.hash)),
      ...(kind === "symlink" && file.symlink_target?.length
        ? { symlinkTarget: hex(file.symlink_target) } : {}) };
  }));
}

/** Proves a local replica matches an entire advertised index, not merely favorite paths. */
export async function verifyLocalReplicaManifest(replica: Pick<LocalFolderReplica, "scan" | "readBlock">,
  expectedFiles: readonly BepFileInfo[]): Promise<string> {
  if (expectedFiles.some(file => isInternalReplicaPath(file.name))) {
    throw new Error("Internal paths cannot be part of a retained folder manifest.");
  }
  const expectedDigest = folderManifestDigestFromBep(expectedFiles);
  const scanDigest = async () => folderManifestDigestFromBep(
    (await replica.scan()).filter(file => !isInternalReplicaPath(file.name)));
  if (await scanDigest() !== expectedDigest) {
    throw new Error("Local replica is not a complete copy of the current folder manifest.");
  }
  for (const file of expectedFiles) {
    if (file.deleted || Number(file.type ?? 0) !== 0) continue;
    for (const block of file.blocks ?? file.Blocks ?? []) {
      const bytes = await replica.readBlock(file.name, block.offset, block.size, block.hash);
      if (bytes.length !== block.size || !equalHash(sha256(bytes), block.hash)) {
        throw new Error("Local replica block digest did not match the folder manifest.");
      }
    }
  }
  if (await scanDigest() !== expectedDigest) {
    throw new Error("Local replica is not a complete copy of the current folder manifest.");
  }
  return expectedDigest;
}

export const defaultFolderRetentionPolicy = (folderId: string, rosterHead: string): FolderRetentionPolicy => ({
  format: 1,
  folderId: text(folderId, "retention folder identifier"),
  minimumCopies: 2,
  revision: 1,
  rosterHead: text(rosterHead, "space device membership head"),
  holders: [],
});

const validatePolicy = (policy: FolderRetentionPolicy) => {
  if (policy.format !== 1) throw new Error("Unsupported folder retention policy format.");
  text(policy.folderId, "retention folder identifier");
  text(policy.rosterHead, "space device membership head");
  integer(policy.revision, "retention policy revision", 1);
  integer(policy.minimumCopies, "minimum copy count", 1);
  const ids = new Set<string>();
  for (const holder of policy.holders) {
    text(holder.id, "retention holder identifier");
    if (!["syncpeer", "syncthing"].includes(holder.kind) || ids.has(holder.id)) {
      throw new Error("Invalid or duplicate retention holder.");
    }
    ids.add(holder.id);
  }
};

const completionData = (value: Omit<ReplicaCompletion, "format" | "signature">) => ({
  format: 1 as const,
  folderId: value.folderId,
  holderId: value.holderId,
  holderKind: value.holderKind,
  signerId: value.signerId,
  manifestDigest: value.manifestDigest,
  policyRevision: value.policyRevision,
  completedAtMs: value.completedAtMs,
  ...(value.liveUntilMs === undefined ? {} : { liveUntilMs: value.liveUntilMs }),
});

const validateCompletionData = (value: ReturnType<typeof completionData>) => {
  text(value.folderId, "completion folder identifier");
  text(value.holderId, "completion holder identifier");
  text(value.signerId, "completion signer identifier");
  text(value.manifestDigest, "completion manifest digest");
  integer(value.policyRevision, "completion policy revision", 1);
  integer(value.completedAtMs, "completion time");
  if (!["syncpeer", "syncthing"].includes(value.holderKind) ||
    value.liveUntilMs !== undefined && (
      integer(value.liveUntilMs, "completion live deadline") < value.completedAtMs ||
      value.liveUntilMs - value.completedAtMs > MAX_COMPLETION_AGE_MS)) {
    throw new Error("Invalid or unbounded replica completion.");
  }
};

const recordBytes = (domain: string, value: unknown) => encoder.encode(`${domain}\n${JSON.stringify(value)}`);
const sign = async (subtle: SubtleCrypto, key: CryptoKey, domain: string, value: unknown) =>
  encode(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, recordBytes(domain, value))));
const verify = async (subtle: SubtleCrypto, publicKey: string | undefined, domain: string,
  value: unknown, signature: string) => {
  if (!publicKey) return false;
  try {
    const key = await subtle.importKey("spki", decode(publicKey),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decode(signature),
      recordBytes(domain, value));
  } catch {
    return false;
  }
};

export async function signReplicaCompletion(subtle: SubtleCrypto, key: CryptoKey,
  value: Omit<ReplicaCompletion, "format" | "signature">): Promise<ReplicaCompletion> {
  if (value.holderKind === "syncpeer" && value.signerId !== value.holderId) {
    throw new Error("A Syncpeer completion must be signed by its holder.");
  }
  if (value.holderKind === "syncthing" && value.liveUntilMs === undefined) {
    throw new Error("A Syncthing completion must be a bounded live observation.");
  }
  const data = completionData(value);
  validateCompletionData(data);
  return { ...data, signature: await sign(subtle, key, "syncpeer.replica-completion.v1", data) };
}

const validCompletion = async (subtle: SubtleCrypto, completion: ReplicaCompletion,
  publicKeys: Readonly<Record<string, string>>, nowMs: number) => {
  if (completion.format !== 1 || completion.completedAtMs > nowMs ||
    completion.holderKind === "syncpeer" && completion.signerId !== completion.holderId ||
    completion.holderKind === "syncthing" && (completion.liveUntilMs === undefined || completion.liveUntilMs < nowMs)) return false;
  const data = completionData(completion);
  try { validateCompletionData(data); } catch { return false; }
  return verify(subtle, publicKeys[completion.signerId], "syncpeer.replica-completion.v1", data, completion.signature);
};

export async function assessFolderRetention(subtle: SubtleCrypto, policy: FolderRetentionPolicy,
  manifestDigest: string, completions: readonly ReplicaCompletion[],
  publicKeys: Readonly<Record<string, string>>, nowMs: number) {
  validatePolicy(policy);
  text(manifestDigest, "folder manifest digest");
  integer(nowMs, "current time");
  const holders = new Map(policy.holders.map(holder => [holder.id, holder.kind]));
  const complete = new Set<string>();
  for (const completion of completions) {
    if (completion.folderId !== policy.folderId || completion.manifestDigest !== manifestDigest ||
      completion.policyRevision !== policy.revision || holders.get(completion.holderId) !== completion.holderKind) continue;
    if (await validCompletion(subtle, completion, publicKeys, nowMs)) complete.add(completion.holderId);
  }
  const completeHolderIds = [...complete].sort();
  return { completeHolderIds, missingCopies: Math.max(0, policy.minimumCopies - completeHolderIds.length),
    targetMet: completeHolderIds.length >= policy.minimumCopies };
}

const proposalData = (value: Omit<RetentionReleaseProposal, "format" | "action" | "id" | "signature">) => ({
  format: 1 as const,
  action: "release-local-copy" as const,
  folderId: value.folderId,
  releaseHolderId: value.releaseHolderId,
  proposerId: value.proposerId,
  policyRevision: value.policyRevision,
  rosterHead: value.rosterHead,
  manifestDigest: value.manifestDigest,
});

export async function signRetentionReleaseProposal(subtle: SubtleCrypto, key: CryptoKey,
  value: Omit<RetentionReleaseProposal, "format" | "action" | "id" | "signature">): Promise<RetentionReleaseProposal> {
  const data = proposalData(value);
  text(data.folderId, "proposal folder identifier");
  text(data.releaseHolderId, "released holder identifier");
  text(data.proposerId, "proposal signer identifier");
  text(data.rosterHead, "proposal membership head");
  text(data.manifestDigest, "proposal manifest digest");
  integer(data.policyRevision, "proposal policy revision", 1);
  const id = digest(recordBytes("syncpeer.retention-release-proposal.v1", data));
  return { ...data, id, signature: await sign(subtle, key, "syncpeer.retention-release-proposal.v1", data) };
}

export async function authorizeReplicaRelease(subtle: SubtleCrypto, input: {
  policy: FolderRetentionPolicy;
  currentManifestDigest: string;
  proposal: RetentionReleaseProposal;
  completions: readonly ReplicaCompletion[];
  /** Holder IDs with a live authenticated session at the release decision, supplied by the local session owner. */
  onlineHolderIds: readonly string[];
  trust: SpaceDeviceMembershipTrust;
  nowMs: number;
}) {
  validatePolicy(input.policy);
  if (!input.trust || input.trust.knownHead !== input.policy.rosterHead ||
    input.trust.knownHead !== input.trust.updates.at(-1)?.hash) {
    throw new Error("Retention release has a stale or invalid trusted membership head.");
  }
  const membership = await verifySpaceDeviceMembership(subtle, input.trust.updates,
    input.trust.genesisKey, input.trust.knownHead);
  const devices = membership.devices.filter(device => device.state === "active");
  const active = new Set(devices.map(device => device.id));
  const publicKeys = Object.fromEntries(devices.map(device => [device.id, device.signingKey]));
  if (!active.size) throw new Error("Invalid active owned-device membership.");
  const proposal = input.proposal;
  const expectedProposal = proposalData(proposal);
  const expectedId = digest(recordBytes("syncpeer.retention-release-proposal.v1", expectedProposal));
  if (proposal.format !== 1 || proposal.action !== "release-local-copy" || proposal.id !== expectedId ||
    proposal.folderId !== input.policy.folderId || proposal.manifestDigest !== input.currentManifestDigest ||
    proposal.policyRevision !== input.policy.revision || proposal.rosterHead !== input.policy.rosterHead ||
    !active.has(proposal.proposerId) || !await verify(subtle, publicKeys[proposal.proposerId],
      "syncpeer.retention-release-proposal.v1", expectedProposal, proposal.signature)) {
    throw new Error("Retention release proposal is invalid or stale.");
  }
  const recentCompletions = input.completions.filter(completion =>
    input.nowMs - completion.completedAtMs <= MAX_COMPLETION_AGE_MS);
  const assessment = await assessFolderRetention(subtle, input.policy, proposal.manifestDigest,
    recentCompletions, publicKeys, input.nowMs);
  if (!assessment.completeHolderIds.includes(proposal.releaseHolderId)) {
    throw new Error("The released holder has no current complete-copy receipt.");
  }
  const online = new Set(input.onlineHolderIds);
  const remainingCompleteHolderIds = assessment.completeHolderIds.filter(id =>
    id !== proposal.releaseHolderId && online.has(id));
  if (remainingCompleteHolderIds.length < input.policy.minimumCopies) {
    throw new Error("Retention release lacks the minimum online complete copies.");
  }
  return { proposalId: proposal.id, remainingCompleteHolderIds };
}

const dangerousReleaseData = (value: Omit<DangerousLocalRelease,
  "format" | "scope" | "guaranteeBroken" | "signature">) => ({
  format: 1 as const,
  scope: "local-copy-only" as const,
  guaranteeBroken: true as const,
  folderId: value.folderId,
  localHolderId: value.localHolderId,
  policyRevision: value.policyRevision,
  rosterHead: value.rosterHead,
  manifestDigest: value.manifestDigest,
  createdAtMs: value.createdAtMs,
});

export async function createDangerousLocalRelease(subtle: SubtleCrypto, key: CryptoKey,
  value: Omit<DangerousLocalRelease, "format" | "scope" | "guaranteeBroken" | "signature"> &
    { confirmedText: string }): Promise<DangerousLocalRelease> {
  if (value.confirmedText !== "RELEASE LOCAL COPY") {
    throw new Error("Type RELEASE LOCAL COPY to confirm the dangerous local release.");
  }
  const data = dangerousReleaseData(value);
  text(data.folderId, "dangerous release folder identifier");
  text(data.localHolderId, "dangerous release holder identifier");
  text(data.rosterHead, "dangerous release membership head");
  text(data.manifestDigest, "dangerous release manifest digest");
  integer(data.policyRevision, "dangerous release policy revision", 1);
  integer(data.createdAtMs, "dangerous release time");
  return { ...data, signature: await sign(subtle, key, "syncpeer.dangerous-local-release.v1", data) };
}

export async function verifyDangerousLocalRelease(subtle: SubtleCrypto, value: DangerousLocalRelease,
  publicKey: string): Promise<boolean> {
  if (value.format !== 1 || value.scope !== "local-copy-only" || value.guaranteeBroken !== true) return false;
  return verify(subtle, publicKey, "syncpeer.dangerous-local-release.v1",
    dangerousReleaseData(value), value.signature);
}
