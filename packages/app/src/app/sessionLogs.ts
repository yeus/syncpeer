import { formatAppBuildInfo, type AppBuildInfo } from "@syncpeer/core/browser";
import { sanitizeDiagnosticArtifact, sanitizeDiagnosticText } from "../../../shared/modules/diagnosticSanitizer.ts";

/**
 * Clipboard writes travel through Android's per-process Binder buffer, which is
 * about 1 MB and shared with every other in-flight transaction. Large session
 * logs therefore belong in a file, not on the clipboard.
 */
export const CLIPBOARD_SESSION_LOG_LIMIT_BYTES = 512 * 1024;

export type SessionLogItem = {
  timestampMs: number;
  level: "info" | "warning" | "error";
  event: string;
  message: string;
  details?: unknown;
};

/** Portable save/share port; only platforms with a file handoff provide it. */
export type SessionLogFilePort = {
  /** Resolves with the saved file name, or null when the user cancels the picker. */
  save: (fileName: string, text: string) => Promise<string | null>;
  share: (fileName: string, text: string) => Promise<void>;
};

export const sessionLogTextSize = (text: string): number =>
  new TextEncoder().encode(text).length;

const formatEntries = (items: readonly SessionLogItem[]): string =>
  items.slice().reverse().map(item => {
    const lines = [
      `${new Date(item.timestampMs).toISOString()} [${item.level.toUpperCase()}] ${item.event}`,
    ];
    if (item.message && item.message !== item.event) {
      lines.push(sanitizeDiagnosticText(item.message));
    }
    if (item.details !== undefined) {
      lines.push(JSON.stringify(sanitizeDiagnosticArtifact(item.details), null, 2));
    }
    return lines.join("\n");
  }).join("\n\n");

/** Include last run's encrypted, recovered history in every explicit export. */
export const formatSessionLogs = (
  appInfo: AppBuildInfo,
  items: readonly SessionLogItem[],
  previousRun?: { startedAtMs: number; items: readonly SessionLogItem[] },
  diagnostics?: { journalStarted: boolean; historyLoaded: boolean; historyError: string },
  currentNative?: readonly SessionLogItem[],
): string => {
  const journal = diagnostics
    ? `# Diagnostic Journal
write_initialized: ${diagnostics.journalStarted}
history_read_succeeded: ${diagnostics.historyLoaded}
history_entry_count: ${previousRun?.items.length ?? 0}
history_error: ${diagnostics.historyError ? sanitizeDiagnosticText(diagnostics.historyError) : "none"}`
    : "";
  const metadata = [formatAppBuildInfo(appInfo), journal, "# Session Logs"].filter(Boolean).join("\n\n");
  const current = formatEntries(items) || "No session logs yet.";
  const currentNativeText = currentNative?.length
    ? `\n\n# Current Native Service Diagnostics (encrypted journal)\n${formatEntries(currentNative)}` : "";
  if (!previousRun || previousRun.items.length === 0) return `${metadata}\n${current}${currentNativeText}`;
  const date = previousRun.startedAtMs
    ? new Date(previousRun.startedAtMs).toISOString() : "unknown";
  return `${metadata}\n${current}${currentNativeText}\n\n# Previous Run Logs (rolling history; newest archived run started ${date})\n${formatEntries(previousRun.items)}`;
};

export const describeSessionLogSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;

/** Guard so a copy attempt cannot silently fail inside the Android clipboard service. */
export const clipboardSessionLogsTooLarge = (text: string): boolean =>
  sessionLogTextSize(text) > CLIPBOARD_SESSION_LOG_LIMIT_BYTES;

/** Stable sortable names for diagnostic exports. */
const exportStamp = (now: Date): string => now.toISOString().replace(/[:.]/g, "-");
export const sessionLogFileName = (now: Date): string =>
  `syncpeer-logs-${exportStamp(now)}.txt`;
export const diagnosticsResultsFileName = (now: Date): string =>
  `syncpeer-diagnostics-${exportStamp(now)}.json`;
