import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeDeviceId } from "../packages/core/dist/core/transport/node.js";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";
import { createSyncpeerBrowserClient } from "../packages/core/dist/ui/browserClient.js";

const identity = async (root: string, name: string) => {
  const cert = path.join(root, `${name}.pem`), key = path.join(root, `${name}.key`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-days", "1", "-subj", "/CN=synthetic-browser-pair", "-keyout", key, "-out", cert],
  { stdio: "ignore" });
  const certPem = await readFile(cert, "utf8");
  return { certPem, keyPem: await readFile(key, "utf8"),
    deviceId: computeDeviceId(new X509Certificate(certPem).raw) };
};

test("browser clients pair over the production LAN TLS adapters and persist only after confirmation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-browser-pairing-"));
  let handle: Awaited<ReturnType<ReturnType<typeof createSyncpeerBrowserClient>["startPairingInvitation"]>> | undefined;
  try {
    const [ownerIdentity, joiningIdentity] = await Promise.all([
      identity(root, "owner"), identity(root, "joining"),
    ]);
    const transfer = { spaceId: "a".repeat(32), settingsFolderId: "b".repeat(32), rootKey: "c".repeat(64) };
    let imported: unknown;
    const codes: string[] = [];
    const owner = createSyncpeerBrowserClient({ hostAdapter: createNodeHostAdapter(), platformAdapter: {
      readDefaultIdentity: async () => ownerIdentity,
      exportPairingTransfer: async () => transfer,
    } });
    const joining = createSyncpeerBrowserClient({ hostAdapter: createNodeHostAdapter(), platformAdapter: {
      readDefaultIdentity: async () => joiningIdentity,
      importPairingTransfer: async (value, password, remember) => {
        imported = { value, password, remember };
      },
    } });
    handle = await owner.startPairingInvitation({ advertisedHost: "127.0.0.1", port: 0,
      confirm: async code => { codes.push(`owner:${code}`); return true; } });
    const joined = await joining.joinPairingInvitation({ invitation: handle.invitation,
      password: "joined-local-password", remember: false,
      confirm: async code => { codes.push(`joining:${code}`); return true; } });
    const accepted = await handle.completed;
    assert.equal(joined.remoteDeviceId.replaceAll("-", ""), ownerIdentity.deviceId.replaceAll("-", ""));
    assert.equal(accepted.remoteDeviceId, joiningIdentity.deviceId.replaceAll("-", ""));
    assert.equal(codes[0].split(":")[1], codes[1].split(":")[1]);
    assert.deepEqual(imported, { value: transfer, password: "joined-local-password", remember: false });
  } finally {
    await handle?.cancel().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
