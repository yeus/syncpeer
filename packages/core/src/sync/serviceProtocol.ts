import { z } from "zod";

/** Increment only for a breaking Android service command/response change. */
export const SERVICE_PROTOCOL_VERSION = 1;

const protocolVersion = z.literal(SERVICE_PROTOCOL_VERSION);
const idText = z.string().min(1).max(4096);
const safePath = z.string().max(4096).refine(value =>
  !value.startsWith("/") && !value.split("/").some(part => part === "." || part === ".."),
{ message: "Invalid remote path." });
const pageLimit = z.number().int().min(1).max(256).optional();
const pageOffset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const hashBytes = z.array(z.number().int().min(0).max(255)).length(32);
const serializedBlock = z.looseObject({ offset: z.number().int().min(0),
  size: z.number().int().min(0), hash: hashBytes });
const folderInfo = z.looseObject({ id: idText, label: z.string().max(4096),
  readOnly: z.boolean() });
const fileEntry = z.looseObject({ name: z.string().max(4096), path: z.string().max(4096),
  type: z.enum(["file", "directory", "symlink"]), size: z.number().int().min(0),
  modifiedMs: z.number(), blocks: z.array(serializedBlock).optional() });
const folderSyncState = z.looseObject({ folderId: idText, remoteIndexId: z.string(),
  remoteMaxSequence: z.string(), indexReceived: z.boolean() });
const remoteDevice = z.looseObject({ id: z.string(), deviceName: z.string(),
  clientName: z.string(), clientVersion: z.string() });
const connectionScope = z.enum(["lan", "wan", "unknown"]);

const connectOptions = z.looseObject({
  host: z.string().min(1).max(4096), port: z.number().int().min(1).max(65535),
  listenPort: z.number().int().min(1).max(65535).optional(),
  discoveryMode: z.enum(["automatic", "global", "lan", "direct"]).optional(),
  discoveryServer: z.string().max(4096).optional(), relayPoolUrl: z.string().max(4096).optional(),
  cert: z.string().max(65536).optional(), key: z.string().max(65536).optional(),
  remoteId: z.string().max(4096).optional(), deviceName: z.string().max(4096),
  timeoutMs: z.number().int().min(0).optional(), enableRelayFallback: z.boolean().optional(),
  relayOnly: z.boolean().optional(), quicOnly: z.boolean().optional(),
  folderPasswords: z.record(z.string(), z.string()).optional(),
  sharedFolders: z.array(z.unknown()).optional(),
});

const uploadOptions = z.looseObject({
  waitForRemote: z.boolean().optional(), expectedHash: z.string().max(256).optional(),
  modifiedMs: z.number().int().min(0).optional(),
});

const command = <T extends string, S extends z.ZodRawShape>(operation: T, shape: S) =>
  z.looseObject({ protocolVersion, operation: z.literal(operation), ...shape });

const commandSchemas = [
  command("connect", { options: connectOptions }),
  command("disconnect", {}),
  command("status", {}),
  command("overview", {}),
  command("listFolders", {}),
  command("setFocusedFolder", { folderId: idText.nullable() }),
  command("requestFolderIndex", { folderId: idText }),
  command("waitForFolderIndex", { folderId: idText,
    timeoutMs: z.number().int().min(0).max(30_000).optional() }),
  command("readDir", { folderId: idText, path: safePath, offset: pageOffset, limit: pageLimit }),
  command("listFiles", { folderId: idText, offset: pageOffset, limit: pageLimit }),
  command("downloadStart", { folderId: idText, path: safePath }),
  command("downloadPull", { transferId: idText }),
  command("downloadCancel", { transferId: idText }),
  command("uploadStart", { folderId: idText, path: safePath,
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), options: uploadOptions.optional() }),
  command("uploadPoll", { uploadId: idText }),
  command("uploadProvide", { uploadId: idText, requestId: idText,
    bytes: z.string().min(4).max(90 * 1024) }),
  command("uploadCancel", { uploadId: idText }),
  command("deleteFile", { folderId: idText, path: safePath, waitForRemote: z.boolean().optional() }),
  command("syncFavorites", {}),
  command("releaseLocalCopy", { folderId: idText, mode: z.enum(["safe", "dangerous"]),
    confirmedText: z.string().max(4096).optional() }),
] as const;

export const serviceCommandSchema = z.discriminatedUnion("operation", commandSchemas);
export type ServiceCommand = z.infer<typeof serviceCommandSchema>;

export const servicePhase = z.enum(["idle", "starting", "connected", "waiting",
  "reconnecting", "suspended", "stopping", "error"]);

export const serviceStatusResponseSchema = z.looseObject({
  phase: z.enum(["idle", "connecting", "connected", "waiting", "reconnecting",
    "suspended", "stopping", "error"]),
  attempt: z.number().int().min(0).optional(), nextRetryAtMs: z.number().int().nullable().optional(),
  closureReason: z.string().nullable().optional(),
  upgradeStatus: z.enum(["idle", "probing", "switching"]).optional(),
  active: z.boolean(), hasOptions: z.boolean().optional(),
  revision: z.number().int().min(0).optional(), foreground: z.boolean().optional(),
  peerPhase: servicePhase.nullable().optional(), peerError: z.string().nullable().optional(),
});

export const overviewResponseSchema = z.looseObject({
  folders: z.array(folderInfo), device: remoteDevice.optional(),
  folderSyncStates: z.array(folderSyncState), connectedVia: z.string(),
  transportKind: z.enum(["direct-tcp", "direct-quic", "relay"]),
  connectionScope: connectionScope.optional(),
});

export const pageResponseSchema = z.looseObject({
  entries: z.array(fileEntry), nextOffset: z.number().int().min(0).nullable(),
  total: z.number().int().min(0),
});

export const downloadFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("begin"), metadata: z.strictObject({
    sourceDeviceId: z.string().max(4096).optional(), folderId: idText,
    path: z.string().max(4096), sizeBytes: z.number().int().min(0),
    encrypted: z.boolean(), contentId: z.string().max(4096).optional(),
  }) }),
  z.strictObject({ type: z.literal("metadataBlocks"), offset: z.number().int().min(0),
    blocks: z.array(serializedBlock).min(1) }),
  z.strictObject({ type: z.literal("metadataEnd"), blockCount: z.number().int().min(0),
    hasBlockPlan: z.boolean() }),
  z.strictObject({ type: z.literal("chunk"), offset: z.number().int().min(0),
    bytes: z.string().min(4).max(90 * 1024) }),
  z.strictObject({ type: z.literal("commit") }),
  z.strictObject({ type: z.literal("error"), message: z.string().max(4096) }),
  z.strictObject({ type: z.literal("pending") }),
]);

export const uploadFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("need"), requestId: idText,
    offset: z.number().int().min(0), size: z.number().int().min(1).max(64 * 1024) }),
  z.strictObject({ type: z.literal("pending") }),
  z.strictObject({ type: z.literal("done") }),
  z.strictObject({ type: z.literal("error"), message: z.string().max(4096) }),
]);

const responseSchemas: Record<string, z.ZodType> = {
  connect: z.looseObject({ phase: z.string() }),
  disconnect: z.looseObject({ phase: z.string() }),
  status: serviceStatusResponseSchema,
  overview: overviewResponseSchema,
  listFolders: z.array(folderInfo),
  setFocusedFolder: z.looseObject({ focused: z.string().nullable() }),
  requestFolderIndex: z.looseObject({ requested: z.literal(true) }),
  waitForFolderIndex: z.boolean(),
  readDir: pageResponseSchema,
  listFiles: pageResponseSchema,
  downloadStart: z.looseObject({ transferId: idText }),
  downloadPull: downloadFrameSchema,
  downloadCancel: z.looseObject({ cancelled: z.literal(true) }),
  uploadStart: z.looseObject({ uploadId: idText }),
  uploadPoll: uploadFrameSchema,
  uploadProvide: z.looseObject({ accepted: z.literal(true) }),
  uploadCancel: z.looseObject({ cancelled: z.literal(true) }),
  deleteFile: z.looseObject({ deleted: z.literal(true) }),
  syncFavorites: z.looseObject({ results: z.array(z.unknown()).optional() }),
};

const issueMessage = (error: z.ZodError): string => {
  const issue = error.issues[0];
  const path = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue?.message ?? "protocol validation failed"}`;
};

export const parseServiceCommand = (value: unknown): ServiceCommand => {
  const result = serviceCommandSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid Android service command: ${issueMessage(result.error)}`);
  return result.data;
};

export const parseServiceResponse = (operation: string, value: unknown): unknown => {
  const schema = responseSchemas[operation];
  if (!schema) return value;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Android service response for ${operation}: ${issueMessage(result.error)}`);
  }
  return result.data;
};

export const withServiceProtocol = (request: Record<string, unknown>) => ({
  protocolVersion: SERVICE_PROTOCOL_VERSION, ...request,
});
