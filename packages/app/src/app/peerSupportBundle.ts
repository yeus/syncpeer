import type { AppBuildInfo } from "@syncpeer/core/browser";
import { sanitizeDiagnosticArtifact, sanitizeDiagnosticText } from "../../../shared/modules/diagnosticSanitizer.ts";
import {
  formatSessionLogs, sessionLogFileName, type SessionLogItem,
} from "./sessionLogs.ts";

/** One shareable Android FileProvider artifact: test report plus same-run
 * WebView and native encrypted-journal trace. No historical journal replay.
 */
export const peerSupportBundleFileName = (date: Date): string =>
  sessionLogFileName(date).replace("syncpeer-logs-", "syncpeer-peer-connectivity-");

export const formatPeerSupportBundle = (
  info: AppBuildInfo,
  diagnosticsJson: string,
  current: readonly SessionLogItem[],
  native: readonly SessionLogItem[],
  journalStarted: boolean,
): string => {
  const report = sanitizeDiagnosticText(
    JSON.stringify(sanitizeDiagnosticArtifact(JSON.parse(diagnosticsJson)), null, 2));
  const logs = formatSessionLogs(info, current, undefined, {
    journalStarted,
    historyLoaded: false,
    historyError: "Previous-run logs intentionally excluded from focused diagnostics.",
  }, native);
  return `# Syncpeer Peer Connectivity Diagnostics
Transport/TLS certificate probes are not BEP or file-transfer tests.
The actual peer IDs, addresses, private keys, and file paths are excluded from this report.

# Focused Test Results
${report}

${logs}`;
};
