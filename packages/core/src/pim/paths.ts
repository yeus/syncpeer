import type { PimDomain, PimRecordFormat, PimRecordRef } from "./types.js";

const ROOT = "syncpeer/pim";

function sanitizeSegment(value: string): string {
  return value.trim().replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

export function formatForDomain(domain: PimDomain): PimRecordFormat {
  return domain === "contacts" ? "vcf" : "ics";
}

export function extensionForFormat(format: PimRecordFormat): string {
  return format === "vcf" ? ".vcf" : ".ics";
}

export function collectionRootPath(domain: PimDomain, collectionId: string): string {
  return `${ROOT}/${domain}/collections/${sanitizeSegment(collectionId)}`;
}

export function canonicalRecordPath(ref: PimRecordRef): string {
  const ext = extensionForFormat(formatForDomain(ref.domain));
  const root = collectionRootPath(ref.domain, ref.collectionId);
  return `${root}/entries/${sanitizeSegment(ref.recordId)}${ext}`;
}

export function sidecarManifestPath(domain: PimDomain, collectionId: string): string {
  return `${collectionRootPath(domain, collectionId)}/meta/manifest.json`;
}

export function sidecarOpPath(args: {
  domain: PimDomain;
  collectionId: string;
  epoch: string;
  opId: string;
}): string {
  const root = collectionRootPath(args.domain, args.collectionId);
  return `${root}/meta/ops/${sanitizeSegment(args.epoch)}/${sanitizeSegment(args.opId)}.json`;
}

export function sidecarTombstonePath(ref: PimRecordRef): string {
  const root = collectionRootPath(ref.domain, ref.collectionId);
  return `${root}/meta/tombstones/${sanitizeSegment(ref.recordId)}.json`;
}

