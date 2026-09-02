const sensitiveDiagnosticKeys = new Set([
  "address",
  "addresses",
  "cert",
  "certificate",
  "connectedvia",
  "deviceid",
  "deviceids",
  "discoveryserver",
  "error",
  "expectedeviceids",
  "filename",
  "folderid",
  "folderids",
  "host",
  "key",
  "knowndeviceids",
  "localpath",
  "missingexpectedeviceids",
  "missingknowndeviceids",
  "output",
  "outputpath",
  "path",
  "readdirsample",
  "remoteid",
  "remotepath",
  "serverdeviceid",
  "stack",
  "uniquedeviceids",
]);

export const sanitizeDiagnosticArtifact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticArtifact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveDiagnosticKeys.has(key.replace(/[^a-z]/gi, "").toLowerCase())
        ? "[redacted]"
        : sanitizeDiagnosticArtifact(entry),
    ]),
  );
};
