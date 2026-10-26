import assert from "node:assert/strict";
import test from "node:test";
import { decodeBase64, encodeBase64 } from "../packages/core/src/transfer/base64.ts";

test("base64 round trips every length and rejects malformed payloads", () => {
  for (let size = 0; size <= 257; size += 1) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 37 + 11) % 256);
    const encoded = encodeBase64(bytes);
    assert.match(encoded, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.deepEqual(decodeBase64(encoded), bytes);
  }
  assert.throws(() => decodeBase64("A"), /base64/i);
  assert.throws(() => decodeBase64("AAAAA"), /base64/i);
  assert.throws(() => decodeBase64("AA=A"), /base64/i);
  assert.throws(() => decodeBase64("!!!!"), /base64/i);
  assert.throws(() => decodeBase64(encodeBase64(new Uint8Array(16)), 8), /limit/i);
});

test("base64 keeps a 32 KiB transfer chunk compact", () => {
  const bytes = new Uint8Array(32 * 1024).fill(0xa5);
  const encoded = encodeBase64(bytes);
  assert.ok(encoded.length < 44 * 1024);
  assert.ok(JSON.stringify({ bytes: encoded }).length < JSON.stringify({ bytes: Array.from(bytes) }).length / 2);
  assert.deepEqual(decodeBase64(encoded), bytes);
});
