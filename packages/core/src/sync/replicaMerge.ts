import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BepFileInfo } from "../core/protocol/bep.js";
import { compareConcurrentVersionCounters, mergeVersionVectors } from "../core/protocol/versionVector.js";
import { compareVersionVectors } from "./folderSync.js";

export const replicaContentSignature = (file: BepFileInfo): string => JSON.stringify({
  type: Number(file.type ?? 0), size: String(file.size ?? 0), deleted: !!file.deleted,
  blocks: (file.blocks ?? []).map(block => [String(block.offset), block.size, Array.from(block.hash)]),
});

export function planReplicaMerge(local: BepFileInfo | undefined, remote: BepFileInfo): {
  action: "keep" | "receive" | "merge";
  winner: BepFileInfo;
  source: "local" | "remote";
  conflict?: BepFileInfo;
} {
  if (!remote.version?.counters?.length || remote.invalid) throw new Error("Remote replica version is unavailable.");
  if (!local) return { action: "receive", winner: remote, source: "remote" };
  if (local.name !== remote.name) throw new Error("Replica paths do not match.");
  const order = compareVersionVectors(local.version, remote.version);
  const localSignature = replicaContentSignature(local);
  const remoteSignature = replicaContentSignature(remote);
  if (order === "unknown") throw new Error("Local replica version is unavailable.");
  if (order === "equal" && localSignature !== remoteSignature) throw new Error("Different contents have the same version.");
  if (order === "after" || order === "equal") return { action: "keep", winner: local, source: "local" };
  if (order === "before") return { action: "receive", winner: remote, source: "remote" };

  // Preserve concurrent live edits over deletions. For two live edits, follow
  // Syncthing's mtime and numeric version-vector tie-break rather than content.
  const rank = Number(!!remote.deleted) - Number(!!local.deleted) ||
    Number(local.modified_s ?? 0) - Number(remote.modified_s ?? 0) ||
    Number(local.modified_ns ?? 0) - Number(remote.modified_ns ?? 0) ||
    compareConcurrentVersionCounters(local.version!, remote.version);
  const source = rank >= 0 ? "local" : "remote";
  const chosen = source === "local" ? local : remote;
  const loser = source === "local" ? remote : local;
  const version = mergeVersionVectors(local.version!, remote.version);
  const winner = { ...chosen, version };
  if (localSignature === remoteSignature || loser.deleted) return { action: "merge", winner, source };
  const suffix = bytesToHex(sha256(new TextEncoder().encode(replicaContentSignature(loser)))).slice(0, 20);
  return { action: "merge", winner, source,
    conflict: { ...loser, name: `${loser.name}.sync-conflict-${suffix}`, version },
  };
}
