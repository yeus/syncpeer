const sensitiveDiagnosticKeys = new Set([
  "address",
  "addresses",
  "cert",
  "certificate",
  "connectedvia",
  "credential",
  "credentials",
  "deviceid",
  "deviceids",
  "discoveryserver",
  "error",
  "filename",
  "folderid",
  "folderids",
  "host",
  "key",
  "localpath",
  "output",
  "outputpath",
  "path",
  "password",
  "passwords",
  "readdirsample",
  "remoteid",
  "remotepath",
  "serverdeviceid",
  "stack",
  "uniquedeviceids",
]);

/**
 * Callers keep prefixing these names (`connectedHost`, `remoteDeviceId`,
 * `folderPasswords`), so a normalized suffix check catches the variants without
 * enumerating every call site. `needsPassword` and `hasFolderPassword` are
 * diagnostic booleans rather than secrets and stay readable.
 */
const sensitiveDiagnosticKeySuffixes = [
  "address",
  "addresses",
  "cert",
  "certificate",
  "clientname",
  "credential",
  "credentials",
  "devicename",
  "deviceid",
  "deviceids",
  "filename",
  "folderid",
  "folderids",
  "host",
  "hosts",
  "password",
  "passwords",
  "path",
  "pem",
  "secret",
  "secrets",
  "token",
  "tokens",
];

const readablePasswordFlags = new Set(["hasfolderpassword", "needspassword"]);

const normalizeDiagnosticKey = (key: string): string =>
  key.replace(/[^a-z]/gi, "").toLowerCase();

const isSensitiveDiagnosticKey = (key: string): boolean => {
  const normalized = normalizeDiagnosticKey(key);
  if (readablePasswordFlags.has(normalized)) return false;
  return sensitiveDiagnosticKeys.has(normalized) ||
    sensitiveDiagnosticKeySuffixes.some((suffix) => normalized.endsWith(suffix));
};

const diagnosticUrlPattern = /\b(?:tcp|quic|relay|udp|file):\/\/[^\s|)]+/gi;
const diagnosticWindowsPathPattern = /\b[a-z]:[\\/][^\s"'`,;):]+/gi;
const diagnosticPosixPathPattern =
  /\/(?:home|users|tmp|var|private|data|storage|mnt|workspace)\/[^\s"'`,;):]+/gi;
const diagnosticIpv4Pattern = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const diagnosticBracketedIpv6Pattern = /\[[0-9a-f:]{2,}\]/gi;
const diagnosticUnbracketedIpv6Pattern = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi;
const diagnosticLongTokenPattern = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Redact free text that reaches exported logs through error messages. */
export const sanitizeDiagnosticText = (text: string): string =>
  text
    .replace(diagnosticUrlPattern, "[redacted]")
    .replace(diagnosticWindowsPathPattern, "[path]")
    .replace(diagnosticPosixPathPattern, "[path]")
    .replace(diagnosticIpv4Pattern, "[redacted]")
    .replace(diagnosticBracketedIpv6Pattern, "[redacted]")
    .replace(diagnosticUnbracketedIpv6Pattern, "[redacted]")
    .replace(diagnosticLongTokenPattern, "[redacted]");

export const sanitizeDiagnosticArtifact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticArtifact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (isSensitiveDiagnosticKey(key)) return [key, "[redacted]"];
      const sanitized = sanitizeDiagnosticArtifact(entry);
      return [key, normalizeDiagnosticKey(key) === "message" && typeof sanitized === "string"
        ? sanitizeDiagnosticText(sanitized)
        : sanitized];
    }),
  );
};
