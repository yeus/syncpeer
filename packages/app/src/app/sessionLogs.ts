import { formatAppBuildInfo, type AppBuildInfo } from "@syncpeer/core/browser";
import { sanitizeDiagnosticArtifact } from "../../../shared/modules/diagnosticSanitizer.ts";

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
  save: (fileName: string, text: string) => Promise<string>;
  share: (fileName: string, text: string) => Promise<void>;
};

export const sessionLogTextSize = (text: string): number =>
  new TextEncoder().encode(text).length;

/** One readable session log for copy, save and share, with sanitized metadata. */
export const formatSessionLogs = (
  appInfo: AppBuildInfo,
  items: readonly SessionLogItem[],
): string => {
  const logBody = items
    .slice()
    .reverse()
    .map((item) => {
      const lines = [
        `${new Date(item.timestampMs).toISOString()} [${item.level.toUpperCase()}] ${item.event}`,
      ];
      // Client-log entries fall back to the event name as their message; only real
      // messages carry information the event name does not already contain.
      if (item.message && item.message !== item.event) lines.push(item.message);
      if (item.details !== undefined) {
        lines.push(JSON.stringify(sanitizeDiagnosticArtifact(item.details), null, 2));
      }
      return lines.join("\n");
    })
    .join("\n\n");
  const metadata = [formatAppBuildInfo(appInfo), "", "# Session Logs"].join("\n");
  return `${metadata}\n${logBody || "No session logs yet."}`;
};

export const describeSessionLogSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;

/** Guard so a copy attempt cannot silently fail inside the Android clipboard service. */
export const clipboardSessionLogsTooLarge = (text: string): boolean =>
  sessionLogTextSize(text) > CLIPBOARD_SESSION_LOG_LIMIT_BYTES;

/** Stable, sortable file name for an exported log. */
export const sessionLogFileName = (now: Date): string =>
  `syncpeer-logs-${now.toISOString().replace(/[:.]/g, "-")}.txt`;
