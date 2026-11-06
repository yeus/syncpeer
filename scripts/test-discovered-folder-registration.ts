import assert from "node:assert/strict";
import test from "node:test";
import { deferDiscoveredFolderRegistration, consentedDiscoveredFolders } from "../packages/core/src/sync/discoveredFolderRegistration.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("explicit introducer folder consent prevents any native metadata registration for unapproved offers", () => {
  const offered = [{ id: "approved", label: "Approved" }, { id: "offered", label: "Offered" }];
  assert.deepEqual(consentedDiscoveredFolders(offered, []), []);
  assert.deepEqual(consentedDiscoveredFolders(offered, ["approved"]), [offered[0]]);
  assert.deepEqual(consentedDiscoveredFolders(offered), offered);
});

test("slow local metadata storage never blocks acknowledging the peer session", async () => {
  const availability = deferred<{ vault: { phase: string } }>();
  const complete = deferred<void>();
  const persisted: string[] = [];
  const errors: unknown[] = [];
  deferDiscoveredFolderRegistration({
    status: () => availability.promise,
    rememberFolder: async folder => { persisted.push(folder.id); complete.resolve(); },
  }, [{ id: "remote", label: "" }], error => errors.push(error));
  // The service command can return connected while the serialized storage
  // queue remains blocked. Nothing is persisted before the vault status.
  assert.deepEqual(persisted, []);
  availability.resolve({ vault: { phase: "unlocked" } });
  await complete.promise;
  assert.deepEqual(persisted, ["remote"]);
  assert.deepEqual(errors, []);
});

test("locked vault skips deferred folder writes without failing the session", async () => {
  const completed = deferred<void>();
  let writes = 0;
  deferDiscoveredFolderRegistration({
    status: async () => { completed.resolve(); return { vault: { phase: "locked" } }; },
    rememberFolder: async () => { writes++; },
  }, [{ id: "remote", label: "Remote" }], () => assert.fail("Unexpected registration failure"));
  await completed.promise;
  await Promise.resolve();
  assert.equal(writes, 0);
});

test("failed metadata registration is reported without rejecting the peer", async () => {
  const reported = deferred<unknown>();
  deferDiscoveredFolderRegistration({
    status: async () => ({ vault: { phase: "unlocked" } }),
    rememberFolder: async () => { throw new Error("Synthetic storage queue failure"); },
  }, [{ id: "remote", label: "Remote" }], reported.resolve);
  assert.match(String(await reported.promise), /Synthetic storage queue failure/);
});
