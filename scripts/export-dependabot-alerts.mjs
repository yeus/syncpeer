import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const columns = [
  "number",
  "severity",
  "package",
  "ecosystem",
  "manifest",
  "scope",
  "relationship",
  "vulnerable_range",
  "patched_version",
  "ghsa",
  "cve",
  "summary",
  "url",
];

const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

const alertRow = (alert) => [
  alert.number,
  alert.security_advisory?.severity,
  alert.dependency?.package?.name,
  alert.dependency?.package?.ecosystem,
  alert.dependency?.manifest_path,
  alert.dependency?.scope,
  alert.dependency?.relationship,
  alert.security_vulnerability?.vulnerable_version_range,
  alert.security_vulnerability?.first_patched_version?.identifier,
  alert.security_advisory?.ghsa_id,
  alert.security_advisory?.cve_id,
  alert.security_advisory?.summary,
  alert.html_url,
].map(csvCell).join(",");

export const alertsToCsv = (alerts) =>
  [columns.join(","), ...alerts.map(alertRow), ""].join("\n");

export const dependabotApiArgs = () => [
    "api",
    "--method", "GET",
    "--paginate",
    "--slurp",
    "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28",
    "repos/{owner}/{repo}/dependabot/alerts",
    "-f", "state=open",
    "-f", "per_page=100",
  ];

const fetchAlerts = () => {
  const result = spawnSync("gh", dependabotApiArgs(), {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "GitHub Dependabot request failed.");
  }
  const pages = JSON.parse(result.stdout);
  if (!Array.isArray(pages)) throw new Error("GitHub returned an unexpected alert payload.");
  return pages.flatMap((page) => Array.isArray(page) ? page : [page]);
};

export const dependabotOutputPath = (argv, root = process.cwd()) => {
  const index = argv.indexOf("--output");
  const value = index < 0
    ? ".tmp/dependabot-alerts-open.csv"
    : argv[index + 1]?.trim();
  if (!value) throw new Error("--output requires a file path.");

  const temporaryRoot = path.resolve(root, ".tmp");
  const destination = path.resolve(root, value);
  const relative = path.relative(temporaryRoot, destination);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Dependabot exports must be written inside .tmp.");
  }
  return destination;
};

const run = () => {
  const destination = dependabotOutputPath(process.argv.slice(2));
  const alerts = fetchAlerts();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, alertsToCsv(alerts), { mode: 0o600 });
  fs.chmodSync(destination, 0o600);
  console.log(`Exported ${alerts.length} open Dependabot alert(s) to ${destination}.`);
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
