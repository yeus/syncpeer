import assert from "node:assert/strict";
import test from "node:test";
import {
  alertsToCsv,
  dependabotApiArgs,
  dependabotOutputPath,
} from "./export-dependabot-alerts.mjs";

test("Dependabot alerts export only review-safe fields", () => {
  const csv = alertsToCsv([{
    number: 42,
    dependency: {
      package: { ecosystem: "npm", name: "example-package" },
      manifest_path: "package-lock.json",
      scope: "development",
      relationship: "indirect",
    },
    security_advisory: {
      ghsa_id: "GHSA-xxxx-yyyy-zzzz",
      cve_id: "CVE-2026-0001",
      summary: "Unsafe parsing, including \"quoted\" input",
      severity: "high",
    },
    security_vulnerability: {
      vulnerable_version_range: "< 2.0.0",
      first_patched_version: { identifier: "2.0.0" },
    },
    html_url: "https://github.com/example/repository/security/dependabot/42",
  }]);

  assert.equal(csv, [
    "number,severity,package,ecosystem,manifest,scope,relationship,vulnerable_range,patched_version,ghsa,cve,summary,url",
    "\"42\",\"high\",\"example-package\",\"npm\",\"package-lock.json\",\"development\",\"indirect\",\"< 2.0.0\",\"2.0.0\",\"GHSA-xxxx-yyyy-zzzz\",\"CVE-2026-0001\",\"Unsafe parsing, including \"\"quoted\"\" input\",\"https://github.com/example/repository/security/dependabot/42\"",
    "",
  ].join("\n"));
});

test("Dependabot export requests every open alert", () => {
  const args = dependabotApiArgs();
  assert.ok(args.includes("state=open"));
  assert.equal(args.some((arg) => arg.startsWith("severity=")), false);
});

test("Dependabot export keeps sensitive output inside the ignored temporary directory", () => {
  const root = "/workspace/project";

  assert.equal(
    dependabotOutputPath([], root),
    "/workspace/project/.tmp/dependabot-alerts-open.csv",
  );
  assert.equal(
    dependabotOutputPath(["--output", ".tmp/security/open.csv"], root),
    "/workspace/project/.tmp/security/open.csv",
  );
  assert.throws(
    () => dependabotOutputPath(["--output", "dependabot.csv"], root),
    /inside \.tmp/,
  );
  assert.throws(
    () => dependabotOutputPath(["--output", ".tmp/../dependabot.csv"], root),
    /inside \.tmp/,
  );
});
