import assert from "node:assert/strict";
import test from "node:test";
import { measureConnectionReadiness, probeServiceReadiness } from "./connection-performance.mjs";

const syntheticProbe = (observations, stepMs = 250) => {
  let elapsed = 0;
  let index = 0;
  return {
    now: () => elapsed,
    sleep: async () => { elapsed += stepMs; },
    probe: async () => observations[Math.min(index++, observations.length - 1)],
  };
};

const serviceProbe = (replies, calls) => probeServiceReadiness({
  call: async operation => {
    calls.push(operation);
    const value = replies[operation];
    if (value instanceof Error) throw value;
    return value;
  },
  expectedDeviceId: "SYNTHETIC",
  expectedFolderId: "folder",
  normalizeDeviceId: value => String(value).replaceAll("-", "").toUpperCase(),
});

test("TypeScript session status without peerPhase requires overview and folder proof", async () => {
  const calls = [];
  const result = await serviceProbe({
    status: { phase: "connected", active: true },
    overview: { transportKind: "direct-tcp", device: { id: "SYNTHETIC" } },
    listFolders: [{ id: "folder" }],
  }, calls);
  assert.deepEqual(calls, ["status", "overview", "listFolders"]);
  assert.equal(result.authenticated, true);
  assert.equal(result.folderReady, true);
});

test("native peerPhase remains authoritative when explicitly supplied", async () => {
  const calls = [];
  const result = await serviceProbe({
    status: { phase: "connected", active: true, peerPhase: "reconnecting" },
    overview: { transportKind: "direct-tcp" },
    listFolders: [{ id: "folder" }],
  }, calls);
  assert.deepEqual(calls, ["status"]);
  assert.equal(result.authenticated, undefined);
  assert.equal(result.phase, "reconnecting");
});

test("connected TypeScript status without a live BEP overview is never accepted", async () => {
  const calls = [];
  const result = await serviceProbe({
    status: { phase: "connected", active: true },
    overview: new Error("Android session is unavailable"),
  }, calls);
  assert.deepEqual(calls, ["status", "overview"]);
  assert.equal(result.authenticated, false);
});

test("authenticated wrong peer identity is always rejected", async () => {
  await assert.rejects(serviceProbe({
    status: { phase: "connected", active: true },
    overview: { transportKind: "direct-quic", device: { id: "WRONG" } },
  }, []), /unexpected synthetic peer/);
});

test("native connected alone cannot bypass BEP overview and live folder readiness", async () => {
  const pending = { phase: "starting", nativeConnected: true, authenticated: false, folderReady: false };
  const valid = { phase: "connected", nativeConnected: true, authenticated: true, folderReady: true };
  const measurements = await measureConnectionReadiness({
    ...syntheticProbe([pending, pending, valid]), stableWindowMs: 500,
    authenticationBudgetMs: 2_000, folderBudgetMs: 2_000,
  });
  assert.equal(measurements.authenticatedMs, 500);
  assert.equal(measurements.folderMs, 500);
  assert.equal(measurements.stableMs, 1_000);
  assert.equal(measurements.prematureConnected, 2);
});

test("an authenticated session must expose its folder before it is usable", async () => {
  const auth = { phase: "connected", nativeConnected: true, authenticated: true, folderReady: false };
  const ready = { ...auth, folderReady: true };
  const measurements = await measureConnectionReadiness({
    ...syntheticProbe([auth, auth, ready]), stableWindowMs: 250,
    authenticationBudgetMs: 2_000, folderBudgetMs: 2_000,
  });
  assert.equal(measurements.authenticatedMs, 0);
  assert.equal(measurements.folderMs, 500);
});

test("the reported 70-second Android startup remains a failing performance regression", async () => {
  const stalled = { phase: "reconnecting", nativeConnected: false, authenticated: false, folderReady: false };
  await assert.rejects(measureConnectionReadiness({
    ...syntheticProbe([stalled], 5_000), authenticationBudgetMs: 20_000,
  }), /Authenticated connection exceeded 20000ms/);
});

test("late authentication cannot pass after the deadline just because it eventually succeeded", async () => {
  const waiting = { phase: "reconnecting", nativeConnected: false, authenticated: false, folderReady: false };
  const ready = { phase: "connected", nativeConnected: true, authenticated: true, folderReady: true };
  await assert.rejects(measureConnectionReadiness({
    ...syntheticProbe([waiting, waiting, ready], 10_000),
    authenticationBudgetMs: 15_000, folderBudgetMs: 25_000,
  }), /Authenticated connection exceeded 15000ms.*phase=connected.*authenticated=true/);
});

test("an authenticated peer that immediately restarts its handshake fails stability", async () => {
  const ready = { phase: "connected", nativeConnected: true, authenticated: true, folderReady: true };
  const stale = { phase: "starting", nativeConnected: false, authenticated: false, folderReady: false };
  await assert.rejects(measureConnectionReadiness({
    ...syntheticProbe([ready, stale]), stableWindowMs: 500,
  }), /flapped/);
});

test("a slow document queue cannot delay the first live folder operation beyond its budget", async () => {
  const onlyAuth = { phase: "connected", nativeConnected: true, authenticated: true, folderReady: false };
  await assert.rejects(measureConnectionReadiness({
    ...syntheticProbe([onlyAuth], 2_000), authenticationBudgetMs: 3_000,
    folderBudgetMs: 5_000,
  }), /Live folder operation exceeded 5000ms/);
});

test("cold-start startup and slow native IPC are charged to the latency budget", async () => {
  const ready = { phase: "connected", nativeConnected: true, authenticated: true, folderReady: true };
  const clock = { elapsed: 8_000 };
  await assert.rejects(measureConnectionReadiness({
    now: () => clock.elapsed, startedAtMs: 0, probe: async () => ready,
    sleep: async ms => { clock.elapsed += ms; },
    authenticationBudgetMs: 5_000,
  }), /Authenticated connection exceeded 5000ms/);
});

test("invalid performance budgets are rejected", async () => {
  await assert.rejects(measureConnectionReadiness({
    ...syntheticProbe([]), folderBudgetMs: 0,
  }), /positive finite/);
});
