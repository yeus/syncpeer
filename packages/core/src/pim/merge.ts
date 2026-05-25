import type {
  PimMergeResult,
  PimOperationEnvelope,
  PimRecordRef,
  PimRecordSnapshot,
  PimRecordVersion,
} from "./types.ts";

function recordRefFromOp(op: PimOperationEnvelope): PimRecordRef {
  return {
    domain: op.domain,
    collectionId: op.collectionId,
    recordId: op.recordId,
  };
}

function compareVersions(left: PimRecordVersion, right: PimRecordVersion): number {
  if (left.updatedAtMs !== right.updatedAtMs) return left.updatedAtMs - right.updatedAtMs;
  if (left.deviceId !== right.deviceId) return left.deviceId.localeCompare(right.deviceId);
  return left.versionId.localeCompare(right.versionId);
}

function ensureUniqueVersion(lineage: PimRecordVersion[], candidate: PimRecordVersion): PimRecordVersion[] {
  if (lineage.some((item) => item.versionId === candidate.versionId)) return lineage;
  const next = [...lineage, candidate];
  next.sort(compareVersions);
  return next;
}

function buildVersion(op: PimOperationEnvelope, payload: string): PimRecordVersion {
  return {
    versionId: op.opId,
    updatedAtMs: op.updatedAtMs,
    deviceId: op.deviceId,
    payload,
  };
}

export function createEmptySnapshot(ref: PimRecordRef): PimRecordSnapshot {
  return {
    ref,
    active: null,
    lineage: [],
    deleted: false,
  };
}

export function mergeOperationIntoSnapshot(
  snapshot: PimRecordSnapshot | null,
  op: PimOperationEnvelope,
  payload: string,
): PimMergeResult {
  const base = snapshot ?? createEmptySnapshot(recordRefFromOp(op));
  if (op.deleted) {
    if (base.deleted) return { snapshot: base, changed: false, reason: "kept_active" };
    return { snapshot: { ...base, active: null, deleted: true }, changed: true, reason: "deleted" };
  }

  const incoming = buildVersion(op, payload);
  const nextLineage = ensureUniqueVersion(base.lineage, incoming);
  const current = base.active;
  if (!current) {
    return {
      snapshot: { ...base, active: incoming, lineage: nextLineage, deleted: false },
      changed: true,
      reason: "created",
    };
  }

  const incomingIsNewer = compareVersions(current, incoming) < 0;
  if (incomingIsNewer) {
    return {
      snapshot: { ...base, active: incoming, lineage: nextLineage, deleted: false },
      changed: true,
      reason: "merged",
    };
  }

  return {
    snapshot: { ...base, lineage: nextLineage, deleted: false },
    changed: nextLineage.length !== base.lineage.length,
    reason: "kept_active",
  };
}

