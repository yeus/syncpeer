import type { SyncpeerSessionHandle } from "../client.js";

export type ConnectionLifecyclePhase =
  | "idle"
  | "connecting"
  | "connected"
  | "waiting"
  | "reconnecting"
  | "suspended"
  | "stopping"
  | "error";

export interface ConnectionLifecycleState {
  phase: ConnectionLifecyclePhase;
  attempt: number;
  nextRetryAtMs: number | null;
  closureReason: string | null;
  upgradeStatus: "idle" | "probing" | "switching";
}

export interface ConnectionLifecycle<TOptions> {
  connect: (options: TOptions) => Promise<SyncpeerSessionHandle>;
  disconnect: () => Promise<void>;
  ensureSession: (options?: TOptions) => Promise<SyncpeerSessionHandle>;
  getSession: () => SyncpeerSessionHandle | null;
  getState: () => ConnectionLifecycleState;
  subscribe: (listener: (state: ConnectionLifecycleState) => void) => () => void;
  setOnline: (online: boolean) => Promise<void>;
  setForeground: (foreground: boolean) => Promise<void>;
  setTransferActive: (active: boolean) => Promise<void>;
}

const initialState = (): ConnectionLifecycleState => ({
  phase: "idle",
  attempt: 0,
  nextRetryAtMs: null,
  closureReason: null,
  upgradeStatus: "idle",
});

export const retryDelayMs = (
  failureStreak: number,
  random: () => number = Math.random,
): number => {
  const base = [1000, 2000, 4000, 8000, 16000][failureStreak] ?? 30000;
  return Math.round(base * (0.8 + Math.max(0, Math.min(1, random())) * 0.4));
};

export const createConnectionLifecycle = <TOptions>(deps: {
  open: (options: TOptions) => Promise<SyncpeerSessionHandle>;
  keyFor: (options: TOptions) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): ConnectionLifecycle<TOptions> => {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const listeners = new Set<(state: ConnectionLifecycleState) => void>();
  let state = initialState();
  let active: SyncpeerSessionHandle | null = null;
  let activeKey = "";
  let desired: TOptions | null = null;
  let opening: Promise<SyncpeerSessionHandle> | null = null;
  let openingKey = "";
  let generation = 0;
  let failureStreak = 0;
  let connectedAtMs = 0;
  let online = true;
  let foreground = true;
  let transferActive = false;
  let upgradeTimerGeneration: number | null = null;

  const update = (next: Partial<ConnectionLifecycleState>): void => {
    state = { ...state, ...next };
    const snapshot = { ...state };
    for (const listener of listeners) listener(snapshot);
  };

  const eligible = (): boolean => online && (foreground || transferActive) && desired !== null;
  const pathRank = (session: SyncpeerSessionHandle): number => {
    if (session.transportKind === "relay") return 1;
    const lan = session.connectionScope === "lan";
    if (session.transportKind === "direct-tcp") return lan ? 5 : 3;
    return lan ? 4 : 2;
  };

  const scheduleUpgrade = (sessionGeneration: number): void => {
    if (!active || pathRank(active) >= 5) return;
    if (upgradeTimerGeneration === sessionGeneration) return;
    upgradeTimerGeneration = sessionGeneration;
    void sleep(60_000).then(async () => {
      if (upgradeTimerGeneration === sessionGeneration) upgradeTimerGeneration = null;
      if (
        sessionGeneration !== generation ||
        !active ||
        !desired ||
        !online ||
        !foreground ||
        transferActive
      ) return;
      const previous = active;
      update({ upgradeStatus: "probing" });
      try {
        const replacement = await deps.open(desired);
        if (sessionGeneration !== generation || active !== previous) {
          await replacement.close().catch(() => undefined);
          return;
        }
        if (pathRank(replacement) <= pathRank(previous)) {
          await replacement.close().catch(() => undefined);
          return;
        }
        update({ upgradeStatus: "switching" });
        active = replacement;
        connectedAtMs = now();
        watchClosure(replacement, sessionGeneration);
        await previous.close().catch(() => undefined);
      } catch {
        // A failed optional probe does not disturb the steady session.
      } finally {
        if (sessionGeneration === generation) {
          update({ upgradeStatus: "idle" });
          scheduleUpgrade(sessionGeneration);
        }
      }
    });
  };

  const scheduleRetry = (reason: string): void => {
    if (!eligible()) return;
    const retryGeneration = generation;
    const delayMs = retryDelayMs(failureStreak, random);
    failureStreak += 1;
    update({
      phase: "waiting",
      attempt: failureStreak,
      nextRetryAtMs: now() + delayMs,
      closureReason: reason,
    });
    void sleep(delayMs).then(async () => {
      if (retryGeneration !== generation || !eligible()) return;
      update({ phase: "reconnecting", nextRetryAtMs: null });
      try {
        await openDesired(retryGeneration);
      } catch {
        // openDesired records the failure and schedules the next attempt.
      }
    });
  };

  const watchClosure = (session: SyncpeerSessionHandle, sessionGeneration: number): void => {
    void session.closed.then((closure) => {
      if (sessionGeneration !== generation || active !== session) return;
      active = null;
      activeKey = "";
      if (now() - connectedAtMs >= 30_000) failureStreak = 0;
      if (closure.kind === "manual" || !desired) {
        update({ phase: "idle", nextRetryAtMs: null, closureReason: closure.message });
        return;
      }
      scheduleRetry(closure.message);
    });
  };

  const openDesired = async (openGeneration: number): Promise<SyncpeerSessionHandle> => {
    if (!desired) throw new Error("No connection options are active.");
    const options = desired;
    const key = deps.keyFor(options);
    if (active && !active.isClosed() && activeKey === key) return active;
    if (opening) return opening;
    update({
      phase: state.phase === "reconnecting" ? "reconnecting" : "connecting",
      nextRetryAtMs: null,
      closureReason: null,
    });
    const pending = (async () => {
      if (active && activeKey !== key) {
        const previous = active;
        active = null;
        activeKey = "";
        await previous.close().catch(() => undefined);
      }
      const session = await deps.open(options);
      if (openGeneration !== generation || !eligible()) {
        await session.close().catch(() => undefined);
        throw new Error("Connection attempt was cancelled.");
      }
      const previous = active;
      active = session;
      activeKey = key;
      connectedAtMs = now();
      update({ phase: "connected", nextRetryAtMs: null, closureReason: null });
      watchClosure(session, openGeneration);
      scheduleUpgrade(openGeneration);
      if (previous && previous !== session) await previous.close().catch(() => undefined);
      return session;
    })();
    opening = pending;
    openingKey = key;
    try {
      return await pending;
    } catch (error) {
      if (openGeneration === generation && eligible()) {
        const message = error instanceof Error ? error.message : String(error);
        scheduleRetry(message);
      }
      throw error;
    } finally {
      if (opening === pending) {
        opening = null;
        openingKey = "";
      }
    }
  };

  const suspend = async (): Promise<void> => {
    generation += 1;
    const previous = active;
    active = null;
    activeKey = "";
    update({ phase: "suspended", nextRetryAtMs: null });
    await previous?.close().catch(() => undefined);
  };

  const attemptNow = async (): Promise<void> => {
    if (!eligible() || (active && !active.isClosed())) return;
    if (opening) {
      await opening.catch(() => undefined);
      return;
    }
    generation += 1;
    try {
      await openDesired(generation);
    } catch {
      // Retry scheduling is owned by openDesired.
    }
  };

  return {
    connect: async (options) => {
      desired = options;
      const key = deps.keyFor(options);
      if (active && !active.isClosed() && activeKey === key) return active;
      if (opening && openingKey === key) return opening;
      generation += 1;
      if (opening) await opening.catch(() => undefined);
      if (!desired || deps.keyFor(desired) !== key) {
        throw new Error("Connection attempt was cancelled.");
      }
      return openDesired(generation);
    },
    disconnect: async () => {
      desired = null;
      generation += 1;
      update({ phase: "stopping", nextRetryAtMs: null });
      const previous = active;
      active = null;
      activeKey = "";
      await previous?.close().catch(() => undefined);
      failureStreak = 0;
      update({ ...initialState() });
    },
    ensureSession: async (options) => {
      if (options) desired = options;
      if (active && !active.isClosed() && desired && activeKey === deps.keyFor(desired)) return active;
      if (!eligible()) throw new Error("Connection is suspended or offline.");
      if (opening && desired && openingKey === deps.keyFor(desired)) return opening;
      generation += 1;
      if (opening) await opening.catch(() => undefined);
      return openDesired(generation);
    },
    getSession: () => active,
    getState: () => ({ ...state }),
    subscribe: (listener) => {
      listeners.add(listener);
      listener({ ...state });
      return () => listeners.delete(listener);
    },
    setOnline: async (nextOnline) => {
      online = nextOnline;
      if (online) await attemptNow();
    },
    setForeground: async (nextForeground) => {
      foreground = nextForeground;
      if (!foreground && !transferActive) await suspend();
      else if (foreground) {
        await attemptNow();
        scheduleUpgrade(generation);
      }
    },
    setTransferActive: async (activeTransfer) => {
      transferActive = activeTransfer;
      if (!transferActive && !foreground) await suspend();
      else if (transferActive) await attemptNow();
      else scheduleUpgrade(generation);
    },
  };
};
