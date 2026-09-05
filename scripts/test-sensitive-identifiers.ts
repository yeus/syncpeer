import assert from "node:assert/strict";
import test from "node:test";
import { scanText } from "./scan-sensitive-identifiers.mjs";

test("redacts and classifies sensitive identifier assignments", () => {
  const findings = scanText(
    'folderId: "ABCDEFGHIJKLMNOPQRST"\napiKey: "not-a-real-key"\nSYNCPEER_API_KEY=hardcoded-value\n',
    "config.json",
  );

  assert.deepEqual(
    findings.map(({ kind, severity }) => ({ kind, severity })),
    [
      { kind: "folder-id", severity: "error" },
      { kind: "credential", severity: "error" },
      { kind: "credential", severity: "error" },
    ],
  );
  assert.ok(findings.every(({ value }) => value.startsWith("<redacted ")));
  assert.ok(findings.every(({ value }) => !value.includes("not-a-real-key")));
});

test("treats explicit test fixtures as informational findings", () => {
  const findings = scanText(
    'deviceId: "ABCDEFGHIJKLMNOPQRST"\napiKey: "fixture-value"\n',
    "scripts/test-fixture.ts",
  );

  assert.deepEqual(
    findings.map(({ kind, severity }) => ({ kind, severity })),
    [
      { kind: "device-id", severity: "info" },
      { kind: "credential", severity: "info" },
    ],
  );
});

test("scans unquoted credentials in configuration files", () => {
  const findings = scanText("api_key: hardcoded-value\n", "settings.yaml");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "credential");
  assert.equal(findings[0]?.severity, "error");
});

test("scans XML identifier attributes and unquoted config identifiers", () => {
  const findings = [
    ...scanText('<folder id="ABCDEFGHIJKLMNOPQRST" />', "settings.xml"),
    ...scanText("folder_id: local-folder\n", "settings.yaml"),
  ];

  assert.deepEqual(
    findings.map(({ kind }) => kind),
    ["folder-id", "folder-id"],
  );
});

test("scans shell and URL credential forms", () => {
  const findings = [
    ...scanText("export SYNCPEER_ACCESS_TOKEN=hardcoded", "release.sh"),
    ...scanText("https://remote.invalid/?api_key=hardcoded", "notes.txt"),
  ];

  assert.deepEqual(
    findings.map(({ kind, severity }) => ({ kind, severity })),
    [
      { kind: "credential", severity: "error" },
      { kind: "credential", severity: "error" },
    ],
  );
});
