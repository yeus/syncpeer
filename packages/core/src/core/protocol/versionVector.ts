import type { BepVersionVector } from "./bep.js";

const numericIdOrder = (a: string, b: string): number => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

const canonicalCounters = (vector: BepVersionVector) => {
  const seen = new Set<string>();
  return (vector.counters ?? []).map(counter => {
    const id = BigInt(String(counter.id));
    const value = BigInt(String(counter.value));
    if (id < 0n || id > 0xffffffffffffffffn || value < 0n || value > 0xffffffffffffffffn || seen.has(String(id))) {
      throw new Error("Invalid or duplicate unsigned version counter.");
    }
    seen.add(String(id));
    return { id: String(id), value: String(value) };
  }).sort((a, b) => numericIdOrder(a.id, b.id));
};

/** Syncthing's concurrent ordering follows the first unequal numeric device counter. */
export const compareConcurrentVersionCounters = (left: BepVersionVector, right: BepVersionVector): number => {
  const a = new Map(canonicalCounters(left).map(counter => [counter.id, BigInt(counter.value)]));
  const b = new Map(canonicalCounters(right).map(counter => [counter.id, BigInt(counter.value)]));
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort(numericIdOrder)) {
    const av = a.get(id) ?? 0n;
    const bv = b.get(id) ?? 0n;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
};

export const versionCounterId = (deviceId: Uint8Array): string => {
  if (deviceId.byteLength < 8) throw new Error("Device identity is too short.");
  const view = new DataView(deviceId.buffer, deviceId.byteOffset, 8);
  return ((BigInt(view.getUint32(0, false)) << 32n) | BigInt(view.getUint32(4, false))).toString();
};

export const mergeVersionVectors = (left: BepVersionVector, right: BepVersionVector): BepVersionVector => {
  const merged = new Map<string, bigint>();
  for (const counter of [...canonicalCounters(left), ...canonicalCounters(right)]) {
    const id = String(counter.id);
    const value = BigInt(String(counter.value));
    merged.set(id, value > (merged.get(id) ?? 0n) ? value : (merged.get(id) ?? 0n));
  }
  return { counters: [...merged].sort(([a], [b]) => numericIdOrder(a, b)).map(([id, value]) => ({ id, value: String(value) })) };
};

/** Preserve causal history; sequence numbers are not version counters. */
export const advanceVersionVector = (previous: BepVersionVector | undefined, deviceId: string): BepVersionVector => {
  const counters = canonicalCounters(previous ?? {});
  const id = String(BigInt(deviceId));
  const own = counters.find(counter => counter.id === id);
  if (own) own.value = String(BigInt(own.value) + 1n);
  else counters.push({ id, value: "1" });
  return { counters: canonicalCounters({ counters }) };
};
