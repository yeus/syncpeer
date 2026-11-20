import { sanitizeDiagnosticArtifact, sanitizeDiagnosticText } from "../../../shared/modules/diagnosticSanitizer.ts";
import type { SessionLogItem } from "./sessionLogs.ts";

export type ArchivedSessionLog = SessionLogItem & { id: string };
type DiagnosticPort = (request: Record<string, unknown>) => Promise<unknown>;
const HISTORY_LIMIT = 4000;
const CURRENT_NATIVE_TRACE_LIMIT = 1500;
const IN_MEMORY_NATIVE_TRACE_LIMIT = 512;
const BATCH_LIMIT = 24;
const QUEUE_LIMIT = 1000;
const MAX_LOG_MESSAGE = 600;
const MAX_LOG_DETAILS = 2400;
const RUN_ID = /^[a-f0-9-]{8,64}$/i;

const objectValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

const sanitizeEntry = (runId: string, item: SessionLogItem): Record<string, unknown> => {
  const event = /^[a-zA-Z0-9._-]{1,128}$/.test(item.event) ? item.event : "diagnostic.invalid_event";
  let details: string | undefined;
  if (item.details !== undefined) {
    try {
      details = JSON.stringify(sanitizeDiagnosticArtifact(item.details))?.slice(0, MAX_LOG_DETAILS);
    } catch { details = '"[unserializable diagnostics]"'; }
  }
  return {
    runId,
    timestampMs: item.timestampMs,
    level: item.level,
    event,
    message: sanitizeDiagnosticText(item.message).slice(0, MAX_LOG_MESSAGE),
    ...(details === undefined ? {} : { details }),
  };
};

const parseEntry = (runId: string, item: unknown, index: number): ArchivedSessionLog | null => {
  const value = objectValue(item);
  if (typeof value.timestampMs !== "number" || !Number.isFinite(value.timestampMs) ||
    !["info", "warning", "error"].includes(String(value.level)) ||
    typeof value.event !== "string" || typeof value.message !== "string") return null;
  let details: unknown = value.details;
  if (typeof details === "string") {
    try { details = JSON.parse(details); } catch { /* Native crash breadcrumb text. */ }
  }
  return {
    id: `archived:${runId}:${index}`,
    timestampMs: value.timestampMs,
    level: value.level as SessionLogItem["level"],
    event: value.event,
    message: value.message,
    ...(details === undefined ? {} : { details }),
  };
};

/**
 * Write-ahead, best-effort diagnostics. The Android journal fsyncs encrypted
 * batches independently of the vault/session. History is loaded separately
 * so decryption and multiple Binder pages cannot delay startup networking.
 */
export const createPersistentSessionLogs = (args: {
  port: DiagnosticPort;
  runId: string;
  /** Defer expensive historical reads until after startup or explicit export. */
  deferHistory?: boolean;
  onRestored?: (value: { startedAtMs: number; items: ArchivedSessionLog[] }) => void;
  onStarted?: (value: { nativePid: number | null }) => void;
  onNativeExit?: (item: ArchivedSessionLog) => void;
}) => {
  if (!RUN_ID.test(args.runId)) throw new Error("Invalid diagnostic run ID.");
  let ready = false;
  let restored = false;
  let beginInFlight: Promise<void> | null = null;
  let restoreInFlight: Promise<void> | null = null;
  let previousRuns: Record<string, unknown>[] | null = null;
  let disposed = false;
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue: Record<string, unknown>[] = [];
  const request = async (value: Record<string, unknown>) => objectValue(await args.port(value));

  const flush = async (): Promise<void> => {
    if (flushing) return flushing;
    if (!ready || disposed || queue.length === 0) return;
    const batch = queue.splice(0, BATCH_LIMIT);
    const task = request({ operation: "append", items: batch }).then(response => {
      if (response.saved !== batch.length)
        throw new Error("Encrypted diagnostic journal did not acknowledge all records.");
    })
      .catch(() => { queue.unshift(...batch); })
      .finally(() => {
        if (flushing === task) flushing = null;
        if (queue.length && !disposed) schedule(1000);
      });
    flushing = task;
    await task;
  };

  /** Explicit export drains the initial backlog, not just the first 24-entry batch.
   * Stop on a failed write rather than retrying indefinitely on the UI path. */
  const flushAll = async (): Promise<void> => {
    const batches = Math.ceil(queue.length / BATCH_LIMIT) + (flushing ? 1 : 0);
    for (let i = 0; i < batches && (queue.length > 0 || flushing); i++) {
      const before = queue.length;
      await flush();
      if (queue.length >= before && !flushing) break;
    }
  };

  const schedule = (delay = 100): void => {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, delay);
  };

  const record = (item: SessionLogItem): void => {
    if (disposed) return;
    queue.push(sanitizeEntry(args.runId, item));
    if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
    schedule(item.level === "error" ? 0 : 100);
  };

  const begin = (): Promise<void> => {
    if (disposed || ready) return Promise.resolve();
    if (beginInFlight) return beginInFlight;
    const work = (async () => {
      const response = await request({ operation: "start", runId: args.runId });
      if (response.started !== true)
        throw new Error("Android diagnostic journal did not confirm initialization.");
      args.onStarted?.({ nativePid: typeof response.nativePid === "number" &&
        Number.isSafeInteger(response.nativePid) ? response.nativePid : null });
      if (response.previousExit) {
        const exit = parseEntry(args.runId, response.previousExit, 0);
        if (exit) args.onNativeExit?.(exit);
      }
      previousRuns = Array.isArray(response.previousRuns)
        ? response.previousRuns.map(objectValue) : null;
      ready = true;
      // Save new errors immediately; historical reads must never hold them.
      schedule(0);
    })();
    beginInFlight = work.finally(() => { beginInFlight = null; });
    return beginInFlight;
  };

  const restore = (): Promise<void> => {
    if (disposed || restored) return Promise.resolve();
    if (restoreInFlight) return restoreInFlight;
    const work = (async () => {
      await begin();
      const listing = previousRuns === null ? await request({ operation: "list" }) : null;
      if (listing !== null && !Array.isArray(listing.runs))
        throw new Error("Android diagnostic journal returned no valid historical run listing.");
      const runs = (previousRuns ??
        (Array.isArray(listing?.runs) ? listing.runs.map(objectValue) : []))
        .filter(run => typeof run.runId === "string" && RUN_ID.test(run.runId) &&
          run.runId !== args.runId)
        .sort((a, b) => Number(b.lastEventAtMs ?? b.startedAtMs ?? 0) -
          Number(a.lastEventAtMs ?? a.startedAtMs ?? 0))
        .slice(0, 8);
      const items: ArchivedSessionLog[] = [];
      for (const run of runs) {
        const startIndex = items.length;
        if (items.length >= HISTORY_LIMIT) break;
        const id = run.runId as string;
        const available = Math.max(0, HISTORY_LIMIT - items.length);
        const total = typeof run.count === "number" && Number.isSafeInteger(run.count)
          ? run.count : null;
        // Favor the newest records when a single prior run exceeds the budget.
        let offset = total === null ? 0 : Math.max(0, total - available);
        while (items.length < HISTORY_LIMIT) {
          const limit = Math.min(100, HISTORY_LIMIT - items.length);
          const page = await request({ operation: "read", runId: id, offset, limit });
          if (!Array.isArray(page.items))
            throw new Error("Android diagnostic journal returned an invalid history page.");
          const values = page.items;
          const parsed = values.map((value, i) => parseEntry(id, value, offset + i));
          if (parsed.some(entry => entry === null))
            throw new Error("Android diagnostic journal returned malformed historical entries.");
          items.push(...parsed as ArchivedSessionLog[]);
          offset += values.length;
          if (values.length < limit || (total !== null && offset >= total)) break;
        }
        // Native journal append order is authoritative. Multiple events can
        // share one millisecond or originate from clocks with slight skew;
        // sorting by timestamp alone can hide the final crash marker.
        const runItems = items.splice(startIndex);
        items.push(...runItems.reverse());
      }
      args.onRestored?.({
        startedAtMs: typeof runs[0]?.startedAtMs === "number" ? runs[0].startedAtMs : 0,
        items,
      });
      restored = true;
    })();
    restoreInFlight = work.finally(() => {
      restoreInFlight = null;
      // Native should not retain the entire decrypted journal after sharing.
      // No need to delay opening the share sheet for this cleanup.
      void request({ operation: "release" }).catch(() => undefined);
    });
    return restoreInFlight;
  };

  /** Fast bounded previous-run tail for regular shares. The full restore()
   * remains available from the History view. Older APKs use that fallback. */
  const readRecentHistory = async (): Promise<void> => {
    if (restored) return;
    await begin();
    let tail: Record<string, unknown>;
    try {
      tail = await request({ operation: "recentHistory", runId: args.runId, limit: 160 });
    } catch {
      await restore();
      return;
    }
    if (!Array.isArray(tail.items)) {
      throw new Error("Android journal returned invalid recent history.");
    }
    const items = tail.items.map((value, index) => parseEntry(args.runId, value, index));
    if (items.some(value => value === null))
      throw new Error("Android journal returned malformed recent history.");
    args.onRestored?.({
      startedAtMs: typeof tail.startedAtMs === "number" ? tail.startedAtMs : 0,
      items: items as ArchivedSessionLog[],
    });
    // The bounded tail is not a full restore; expanding history can still
    // request all available older records.
  };

  /** Explicit exports must contain native TLS/QUIC/relay diagnostics from THIS
   * run. The UI's live log observer never sees native service journal events;
   * restore() intentionally reads only PREVIOUS runs.
   */
  const readCurrentNativeTrace = async (
    maxEntries = CURRENT_NATIVE_TRACE_LIMIT,
  ): Promise<ArchivedSessionLog[]> => {
    await begin();
    const boundedEntries = Number.isFinite(maxEntries)
      ? Math.max(1, Math.min(CURRENT_NATIVE_TRACE_LIMIT, Math.floor(maxEntries)))
      : CURRENT_NATIVE_TRACE_LIMIT;
    // Android native events are kept in a bounded current-process ring as
    // well as encrypted on disk. Prefer this zero-decryption path. Other/
    // older plugin backends may fall back to the journal scan below.
    try {
      const tail = await request({
        operation: "recentNative", runId: args.runId,
        limit: Math.min(boundedEntries, IN_MEMORY_NATIVE_TRACE_LIMIT),
      });
      if (Array.isArray(tail.items)) {
        const parsed = tail.items.map((value, index) =>
          parseEntry(args.runId, value, index));
        if (parsed.some(value => value === null))
          throw new Error("Invalid native diagnostic tail.");
        return parsed as ArchivedSessionLog[];
      }
    } catch {
      // Older Android plugin without recentNative; retain historical fallback.
    }
    const listing = await request({ operation: "list" });
    if (!Array.isArray(listing.runs))
      throw new Error("Android diagnostic journal returned no current-run listing.");
    const run = listing.runs.map(objectValue).find(value => value.runId === args.runId);
    const total = run?.count;
    if (!Number.isSafeInteger(total) || (total as number) < 0)
      throw new Error("Android diagnostic journal has no valid current run.");
    const items: ArchivedSessionLog[] = [];
    // Focused shares can request a smaller tail to avoid many sequential
    // Android Binder reads, while a full manual export keeps its larger cap.
    let offset = Math.max(0, (total as number) - boundedEntries);
    try {
      while (offset < (total as number)) {
        const limit = Math.min(100, (total as number) - offset);
        const page = await request({ operation: "read", runId: args.runId, offset, limit });
        if (!Array.isArray(page.items) || page.items.length === 0)
          throw new Error("Android diagnostic journal returned an incomplete current-run page.");
        const parsed = page.items.map((value, i) => parseEntry(args.runId, value, offset + i));
        if (parsed.some(item => item === null))
          throw new Error("Android diagnostic journal returned invalid native diagnostics.");
        items.push(...parsed as ArchivedSessionLog[]);
        offset += parsed.length;
      }
    } finally {
      await request({ operation: "release" }).catch(() => undefined);
    }
    // The rest of the current-run UI logs are already in app.logs.items.
    // Include only events that the native service records independently.
    return items.filter(item => item.event.startsWith("native.") ||
      item.event.startsWith("core.discovery.") || item.event.startsWith("core.session.connect."));
  };

  const start = async (): Promise<void> => {
    await begin();
    if (!args.deferHistory) await restore();
  };

  const dispose = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (ready && queue.length) void flush();
    disposed = true;
  };

  return { record, start, restore, readRecentHistory, readCurrentNativeTrace,
    flush, flushAll, dispose, pending: () => queue.length };
};
