import type { BepVersionVector } from "./bep.js";

/** Preserve causal history; sequence numbers are not version counters. */
export const advanceVersionVector = (previous: BepVersionVector | undefined, deviceId: string): BepVersionVector => {
  const counters = (previous?.counters ?? []).map(counter => ({ id: String(counter.id), value: String(counter.value) }));
  const own = counters.find(counter => counter.id === deviceId);
  if (own) own.value = String(BigInt(own.value) + 1n);
  else counters.push({ id: deviceId, value: "1" });
  return { counters };
};
