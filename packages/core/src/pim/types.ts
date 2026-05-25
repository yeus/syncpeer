export type PimDomain = "contacts" | "calendar";

export type PimRecordFormat = "vcf" | "ics";

export interface PimRecordRef {
  domain: PimDomain;
  collectionId: string;
  recordId: string;
}

export interface PimRecordVersion {
  versionId: string;
  updatedAtMs: number;
  deviceId: string;
  payload: string;
}

export interface PimOperationEnvelope {
  opId: string;
  domain: PimDomain;
  collectionId: string;
  recordId: string;
  deviceId: string;
  createdAtMs: number;
  updatedAtMs: number;
  payloadHash: string;
  deleted: boolean;
}

export interface PimRecordSnapshot {
  ref: PimRecordRef;
  active: PimRecordVersion | null;
  lineage: PimRecordVersion[];
  deleted: boolean;
}

export interface PimMergeResult {
  snapshot: PimRecordSnapshot;
  changed: boolean;
  reason: "created" | "merged" | "kept_active" | "deleted";
}

