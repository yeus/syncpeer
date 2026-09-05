#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SELF = "scripts/scan-sensitive-identifiers.mjs";
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".gradle",
  ".tools",
  ".flatpak-builder",
  ".direnv",
  "node_modules",
  "target",
  "gen",
  "dist",
  "build",
  "coverage",
  "Syncpeer.AppDir",
]);

const identifierKey = /\b((?:(?:device|folder|remote|server|trusted|untrusted|client)[-_]?(?:device[-_]?)?id))\b\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/gi;
const identifierAttribute = /\b((?:device|folder|remote)[ \t]+id)\b\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
const configIdentifierKey = /(?:^|[-,{\x5b])[ \t]*((?:(?:device|folder|remote|server|trusted|untrusted|client)[-_]?(?:device[-_]?)?id))\b\s*[:=]\s*([^\s,;}\]]+)/gi;
const credentialKey = /\b((?:[A-Za-z0-9]+[_-])?(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:entication)?[_-]?token|client[_-]?secret|session[_-]?token|id[_-]?token|password|passphrase|private[_-]?key|signing[_-]?key|encryption[_-]?(?:key|password)|registry[_-]?password|webhook[_-]?secret|secret(?:[_-]?key)?))\b\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/gi;
const configCredentialKey = /(?:^|[-,{\x5b])[ \t]*((?:[A-Za-z0-9]+[_-])?(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:entication)?[_-]?token|client[_-]?secret|session[_-]?token|id[_-]?token|password|passphrase|private[_-]?key|signing[_-]?key|encryption[_-]?(?:key|password)|registry[_-]?password|webhook[_-]?secret|secret(?:[_-]?key)?))\b\s*[:=]\s*([^\s,;}\]]+)/gi;
const credentialQuery = /[?&](?:[A-Za-z0-9]+[_-])?(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:entication)?[_-]?token|client[_-]?secret|session[_-]?token|password|passphrase|secret(?:[_-]?key)?)=([^&#\s]+)/gi;
const environmentCredential = /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|SECRET[_-]?ACCESS[_-]?KEY|PASSWORD|PASSPHRASE|PRIVATE[_-]?KEY|TOKEN|SECRET))\b\s*=\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s#;]+))/g;
const syncthingDeviceId = /\b(?:[A-Z2-9]{6,8}-){7,8}[A-Z2-9]{6,8}\b/g;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const knownToken = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:live|test)?[_-]?[A-Za-z0-9]{20,}|rk_(?:live|test)_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xapp-[0-9A-Za-z-]{20,}|sq0atp-[0-9A-Za-z-]{20,})\b/g;
const authorization = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}\b/gi;
const urlCredential = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/gi;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ipv6 = /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*[0-9a-f]\b/gi;
const localPath = /(?:\/(?:home|Users|workspace|sandbox-home)\/[^\s"'`]+|[A-Z]:\\Users\\[^\s"'`]+)/g;
const pemHeader = /^\s*-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|CERTIFICATE)-----\s*$/;

const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);

const isFixtureValue = (value, filePath, lineText = "") => {
  const normalizedPath = filePath.toLowerCase();
  const normalizedValue = value.toLowerCase();
  const fixturePath = normalizedPath.includes("/test") || normalizedPath.includes("fixture");
  const fixtureContext = /(?:fixture|synthetic|example|dummy|fake|placeholder|unknown|anonymous)/i.test(lineText);
  return fixturePath ||
    /(?:localhost|127\.0\.0\.1|::1)/.test(normalizedValue) ||
    /^(?:undefined|null|none|true|false|empty)$/.test(normalizedValue) ||
    /\$\{?[a-z0-9_]+\}?/i.test(value) ||
    value.includes("$(") ||
    /^\$[0-9]$/.test(value.trim()) ||
    lineText.includes("process.env.") ||
    fixtureContext ||
    /^<[^>]+>$/.test(value.trim());
};

const isKnownPublicValue = (filePath, lineText) =>
  (filePath.endsWith("/discoveryServer.ts") || filePath.endsWith("/discoveryServer.js")) &&
  /(?:[A-Z2-9]{6,8}-){7,8}/i.test(lineText);

const isConfigFile = (filePath) =>
  /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:cfg|conf|ini|properties|toml|yaml|yml))$/i.test(filePath);

const isShellFile = (filePath) => /\.(?:bash|fish|ksh|sh|zsh)$/i.test(filePath);

const isAssignmentFile = (filePath) => isConfigFile(filePath) || isShellFile(filePath);

const isMarkupFile = (filePath) => /\.(?:html?|svg|xhtml|xml)$/i.test(filePath);

const severityFor = (kind, value, filePath, lineText) => {
  if (kind === "scan-error") return "error";
  if (kind === "scan-skipped") return "info";
  if (isKnownPublicValue(filePath, lineText)) return "info";
  if (kind === "credential" || kind === "token" || kind === "private-key") {
    return isFixtureValue(value, filePath, lineText) ? "info" : "error";
  }
  if ((kind === "device-id" || kind === "folder-id") && !isFixtureValue(value, filePath, lineText)) return "error";
  return isFixtureValue(value, filePath, lineText) ? "info" : "warning";
};

const finding = (kind, value, filePath, line, column, lineText = "") => ({
  kind,
  severity: severityFor(kind, value, filePath, lineText),
  file: filePath,
  line,
  column,
  value: `<redacted len=${value.length} sha256=${digest(value)}>`,
});

const addMatch = (findings, seen, kind, value, filePath, line, column, lineText) => {
  if (!value) return;
  const item = finding(kind, value, filePath, line, column, lineText);
  const key = `${item.kind}:${item.file}:${item.line}:${item.column}:${item.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(item);
};

const addRegexMatches = (findings, seen, kind, expression, lineText, filePath, line) => {
  expression.lastIndex = 0;
  for (const match of lineText.matchAll(expression)) {
    addMatch(findings, seen, kind, match[0], filePath, line, (match.index ?? 0) + 1, lineText);
  }
};

const addAssignments = (findings, seen, expression, lineText, filePath, line, kind) => {
  expression.lastIndex = 0;
  for (const match of lineText.matchAll(expression)) {
    const value = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
    const valueOffset = match[0].lastIndexOf(value);
    const matchKind = typeof kind === "function" ? kind(match[1]) : kind;
    addMatch(findings, seen, matchKind, value, filePath, line, (match.index ?? 0) + valueOffset + 1, lineText);
  }
};

const scanLine = (lineText, filePath, line) => {
  const findings = [];
  const seen = new Set();
  if (pemHeader.test(lineText)) {
    const kind = lineText.includes("PRIVATE KEY") ? "private-key" : "certificate";
    addMatch(findings, seen, kind, lineText.trim(), filePath, line, 1, lineText);
  }
  addAssignments(
    findings,
    seen,
    identifierKey,
    lineText,
    filePath,
    line,
    (key) => key.toLowerCase().includes("folder") ? "folder-id" : "device-id",
  );
  if (isMarkupFile(filePath)) {
    addAssignments(
      findings,
      seen,
      identifierAttribute,
      lineText,
      filePath,
      line,
      (key) => key.toLowerCase().includes("folder") ? "folder-id" : "device-id",
    );
  }
  if (isAssignmentFile(filePath)) {
    addAssignments(findings, seen, configIdentifierKey, lineText, filePath, line, (key) =>
      key.toLowerCase().includes("folder") ? "folder-id" : "device-id");
  }
  addAssignments(findings, seen, credentialKey, lineText, filePath, line, "credential");
  if (isAssignmentFile(filePath)) {
    addAssignments(findings, seen, configCredentialKey, lineText, filePath, line, "credential");
  }
  addRegexMatches(findings, seen, "credential", credentialQuery, lineText, filePath, line);
  addAssignments(findings, seen, environmentCredential, lineText, filePath, line, "credential");
  addRegexMatches(findings, seen, "device-id", syncthingDeviceId, lineText, filePath, line);
  addRegexMatches(findings, seen, "uuid", uuid, lineText, filePath, line);
  addRegexMatches(findings, seen, "token", jwt, lineText, filePath, line);
  addRegexMatches(findings, seen, "token", knownToken, lineText, filePath, line);
  addRegexMatches(findings, seen, "token", authorization, lineText, filePath, line);
  addRegexMatches(findings, seen, "url-credential", urlCredential, lineText, filePath, line);
  addRegexMatches(findings, seen, "network-address", ipv4, lineText, filePath, line);
  addRegexMatches(findings, seen, "network-address", ipv6, lineText, filePath, line);
  addRegexMatches(findings, seen, "local-path", localPath, lineText, filePath, line);
  return findings;
};

export const scanText = (text, filePath = "<text>") =>
  text.split(/\r?\n/).flatMap((lineText, index) => scanLine(lineText, filePath, index + 1));

const listGitCandidates = (root) => {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter(Boolean).map((file) => path.resolve(root, file));
};

const walkFiles = async (directory, output) => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(absolute, output);
    else if (entry.isFile()) output.push(absolute);
  }
};

const candidateFiles = async (root, includeIgnored) => {
  const candidates = includeIgnored ? null : listGitCandidates(root);
  if (candidates) return candidates;
  const fallback = [];
  await walkFiles(root, fallback);
  return fallback;
};

const isBinary = async (filePath) => {
  const handle = await fs.open(filePath, "r");
  try {
    const sample = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
};

const scanFile = async (filePath, root) => {
  const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
  if (relative === SELF || relative.startsWith("../")) return { findings: [], skipped: false };
  const metadata = await fs.stat(filePath);
  if (metadata.size > MAX_FILE_BYTES) {
    return { findings: [finding("scan-skipped", `file larger than ${MAX_FILE_BYTES} bytes`, relative, 1, 1)], skipped: true };
  }
  if (await isBinary(filePath)) return { findings: [], skipped: true };
  const findings = [];
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  for await (const text of lines) {
    line += 1;
    findings.push(...scanLine(text, relative, line));
  }
  return { findings, skipped: false };
};

export const parseOptions = (argv) => ({
  includeIgnored: argv.includes("--all"),
  strict: argv.includes("--strict"),
  json: argv.includes("--json"),
  verbose: argv.includes("--verbose"),
  help: argv.includes("--help") || argv.includes("-h"),
});

const printHelp = () => {
  console.log("Usage: node scripts/scan-sensitive-identifiers.mjs [options]");
  console.log("  --all       include ignored logs and generated text");
  console.log("  --strict    fail on warnings as well as errors");
  console.log("  --verbose   print redacted warning locations");
  console.log("  --json      print a machine-readable redacted report");
};

export const scanRepository = async (root, options) => {
  const files = await candidateFiles(root, options.includeIgnored);
  const findings = [];
  let skipped = 0;
  for (const filePath of files) {
    try {
      const result = await scanFile(filePath, root);
      findings.push(...result.findings);
      if (result.skipped) skipped += 1;
    } catch (error) {
      const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
      findings.push(finding("scan-error", error instanceof Error ? error.message : String(error), relative, 1, 1));
    }
  }
  return { files: files.length, skipped, findings };
};

const printReport = (report, options) => {
  const errors = report.findings.filter((item) => item.severity === "error");
  const warnings = report.findings.filter((item) => item.severity === "warning");
  if (options.json) {
    console.log(JSON.stringify({ ...report, findings: report.findings }, null, 2));
    return errors.length > 0 || (options.strict && warnings.length > 0) ? 1 : 0;
  }
  const mode = options.includeIgnored ? "all repository text" : "commit candidates";
  console.log(`Sensitive identifier scan (${mode}): ${report.files} file(s), ${report.findings.length} finding(s).`);
  for (const item of report.findings) {
    if (item.severity === "info" || (item.severity === "warning" && !options.verbose)) continue;
    console.log(`${item.severity.toUpperCase()} ${item.kind} ${item.file}:${item.line}:${item.column} ${item.value}`);
  }
  if (warnings.length > 0 && !options.verbose) console.log(`${warnings.length} warning(s) hidden; rerun with --verbose to inspect redacted locations.`);
  if (report.skipped > 0) console.log(`${report.skipped} binary/large file(s) skipped.`);
  if (errors.length === 0) console.log("Sensitive identifier scan passed.");
  return errors.length > 0 || (options.strict && warnings.length > 0) ? 1 : 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }
  const root = process.cwd();
  const report = await scanRepository(root, options);
  process.exitCode = printReport(report, options);
}
