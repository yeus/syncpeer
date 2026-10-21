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
  adopt: (options: TOptions, session: SyncpeerSessionHandle) => Promise<boolean>;
  /** Adopt an incoming session when no connect attempt is active. */
  adoptIncoming: (options: TOptions, session: SyncpeerSessionHandle) => Promise<boolean>;
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

export const waitForLifecyclePhase = <TOptions>(
  lifecycle: Pick<ConnectionLifecycle<TOptions>, "getState" | "subscribe">,
  phase: ConnectionLifecyclePhase,
  timeoutMs: number,
): Promise<boolean> => {
  if (lifecycle.getState().phase === phase) return Promise.resolve(true);
  return new Promise<boolean>(resolve => {
    let unsubscribe = () => {};
    let settled = false;
    const finish = (reached: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(reached);
    };
    const timer = setTimeout(() => finish(lifecycle.getState().phase === phase), timeoutMs);
    unsubscribe = lifecycle.subscribe(state => {
      if (state.phase === phase) finish(true);
    });
    if (settled) unsubscribe();
  });
};

export type ConnectionLifecycleDeps<TOptions> = {
  open: (options: TOptions, signal: AbortSignal) => Promise<SyncpeerSessionHandle>;
  keyFor: (options: TOptions) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

class ConnectionLifecycleRuntime<TOptions> {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly listeners = new Set<(state: ConnectionLifecycleState) => void>();
  private state = initialState();
  private active: SyncpeerSessionHandle | null = null;
  private activeKey = "";
  private desired: TOptions | null = null;
  private opening: Promise<SyncpeerSessionHandle> | null = null;
  private openingKey = "";
  private openingController: AbortController | null = null;
  private generation = 0;
  private failureStreak = 0;
  private connectedAtMs = 0;
  private online = true;
  private foreground = true;
  private transferActive = false;
  private upgradeTimerGeneration: number | null = null;
  private upgradeController: AbortController | null = null;

  constructor(private readonly deps: ConnectionLifecycleDeps<TOptions>) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
  }

  private update = (next: Partial<ConnectionLifecycleState>): void => {
    this.state = { ...this.state, ...next };
    const snapshot = { ...this.state };
    for (const listener of this.listeners) listener(snapshot);
  };

  private eligible = (): boolean => this.online && (this.foreground || this.transferActive) && this.desired !== null;
  private cancelOpening = (): void => {
    this.openingController?.abort();
    this.openingController = null;
    this.opening = null;
    this.openingKey = "";
    this.upgradeController?.abort();
    this.upgradeController = null;
  };
  private pathRank = (session: SyncpeerSessionHandle): number => {
    if (session.transportKind === "relay") return 1;
    const lan = session.connectionScope === "lan";
    if (session.transportKind === "direct-tcp") return lan ? 5 : 3;
    return lan ? 4 : 2;
  };

  private scheduleUpgrade = (sessionGeneration: number): void => {
    if (!this.active || this.pathRank(this.active) >= 5) return;
    if (this.upgradeTimerGeneration === sessionGeneration) return;
    this.upgradeTimerGeneration = sessionGeneration;
    void this.sleep(60_000).then(async () => {
      if (this.upgradeTimerGeneration === sessionGeneration) this.upgradeTimerGeneration = null;
      if (
        sessionGeneration !== this.generation ||
        !this.active ||
        !this.desired ||
        !this.online ||
        !this.foreground ||
        this.transferActive
      ) return;
      const previous = this.active;
      const controller = new AbortController();
      this.upgradeController = controller;
      this.update({ upgradeStatus: "probing" });
      try {
        const replacement = await this.deps.open(this.desired, controller.signal);
        if (sessionGeneration !== this.generation || this.active !== previous) {
          await replacement.close().catch(() => undefined);
          return;
        }
        if (this.pathRank(replacement) <= this.pathRank(previous)) {
          await replacement.close().catch(() => undefined);
          return;
        }
        this.update({ upgradeStatus: "switching" });
        this.active = replacement;
        this.connectedAtMs = this.now();
        this.watchClosure(replacement, sessionGeneration);
        await previous.close().catch(() => undefined);
      } catch {
        // A failed optional probe does not disturb the steady session.
      } finally {
        if (this.upgradeController === controller) this.upgradeController = null;
        if (sessionGeneration === this.generation) {
          this.update({ upgradeStatus: "idle" });
          this.scheduleUpgrade(sessionGeneration);
        }
      }
    });
  };

  private scheduleRetry = (reason: string): void => {
    if (!this.eligible()) return;
    const retryGeneration = this.generation;
    const delayMs = retryDelayMs(this.failureStreak, this.random);
    this.failureStreak += 1;
    this.update({
      phase: "waiting",
      attempt: this.failureStreak,
      nextRetryAtMs: this.now() + delayMs,
      closureReason: reason,
    });
    void this.sleep(delayMs).then(async () => {
      if (retryGeneration !== this.generation || !this.eligible()) return;
      this.update({ phase: "reconnecting", nextRetryAtMs: null });
      try {
        await this.openDesired(retryGeneration);
      } catch {
        // openDesired records the failure and schedules the next attempt.
      }
    });
  };

  private watchClosure = (session: SyncpeerSessionHandle, sessionGeneration: number): void => {
    void session.closed.then((closure) => {
      if (sessionGeneration !== this.generation || this.active !== session) return;
      this.active = null;
      this.activeKey = "";
      if (this.now() - this.connectedAtMs >= 30_000) this.failureStreak = 0;
      if (closure.kind === "manual" || !this.desired) {
        this.update({ phase: "idle", nextRetryAtMs: null, closureReason: closure.message });
        return;
      }
      this.scheduleRetry(closure.message);
    });
  };

  private openDesired = async (openGeneration: number): Promise<SyncpeerSessionHandle> => {
    if (!this.desired) throw new Error("No connection options are active.");
    const options = this.desired;
    const key = this.deps.keyFor(options);
    if (this.active && !this.active.isClosed() && this.activeKey === key) return this.active;
    if (this.opening) return this.opening;
    this.update({
      phase: this.state.phase === "reconnecting" ? "reconnecting" : "connecting",
      nextRetryAtMs: null,
      closureReason: null,
    });
    const controller = new AbortController();
    this.openingController = controller;
    const pending = (async () => {
      if (this.active && this.activeKey !== key) {
        const previous = this.active;
        this.active = null;
        this.activeKey = "";
        await previous.close().catch(() => undefined);
      }
      const session = await this.deps.open(options, controller.signal);
      if (controller.signal.aborted || openGeneration !== this.generation || !this.eligible()) {
        // Adoption transfers ownership to the current lifecycle generation.
        // A stale opening must compare that session with the desired revision,
        // rather than close it because its captured revision is older.
        if (this.active === session && this.desired && this.activeKey === this.deps.keyFor(this.desired) &&
          !session.isClosed() && this.eligible()) return session;
        await session.close().catch(() => undefined);
        throw new Error("Connection attempt was cancelled.");
      }
      const previous = this.active;
      this.active = session;
      this.activeKey = key;
      this.connectedAtMs = this.now();
      this.update({ phase: "connected", nextRetryAtMs: null, closureReason: null });
      this.watchClosure(session, openGeneration);
      this.scheduleUpgrade(openGeneration);
      if (previous && previous !== session) await previous.close().catch(() => undefined);
      return session;
    })();
    this.opening = pending;
    this.openingKey = key;
    try {
      return await pending;
    } catch (error) {
      if (openGeneration === this.generation && this.eligible()) {
        const message = error instanceof Error ? error.message : String(error);
        this.scheduleRetry(message);
      }
      throw error;
    } finally {
      if (this.opening === pending) {
        this.opening = null;
        this.openingKey = "";
        this.openingController = null;
      }
    }
  };

  private suspend = async (): Promise<void> => {
    this.generation += 1;
    this.cancelOpening();
    const previous = this.active;
    this.active = null;
    this.activeKey = "";
    this.update({ phase: "suspended", nextRetryAtMs: null });
    await previous?.close().catch(() => undefined);
  };

  private attemptNow = async (): Promise<void> => {
    if (!this.eligible() || (this.active && !this.active.isClosed())) return;
    if (this.opening) {
      await this.opening.catch(() => undefined);
      return;
    }
    this.generation += 1;
    try {
      await this.openDesired(this.generation);
    } catch {
      // Retry scheduling is owned by openDesired.
    }
  };

  private ensureSession = async (options?: TOptions): Promise<SyncpeerSessionHandle> => {
    if (options) this.desired = options;
    if (this.active && !this.active.isClosed() && this.desired && this.activeKey === this.deps.keyFor(this.desired)) return this.active;
    if (!this.eligible()) throw new Error("Connection is suspended or offline.");
    if (this.opening && this.desired && this.openingKey === this.deps.keyFor(this.desired)) return this.opening;
    this.generation += 1;
    const refreshGeneration = this.generation;
    if (this.opening) {
      const staleOpening = this.opening;
      this.cancelOpening();
      await staleOpening.catch(() => undefined);
    }
    const current = this.desired;
    if (!current) throw new Error("No connection options are active.");
    if (refreshGeneration !== this.generation) return this.ensureSession(current);
    try {
      return await this.openDesired(refreshGeneration);
    } catch (error) {
      if (this.active && !this.active.isClosed() && this.activeKey === this.deps.keyFor(current)) return this.active;
      if (refreshGeneration !== this.generation && this.desired !== null &&
        this.deps.keyFor(this.desired) === this.deps.keyFor(current)) return this.ensureSession(current);
      throw error;
    }
  };

  private connect = async (options: TOptions) => {
      this.desired = options;
      if (!this.eligible()) throw new Error("Connection is suspended or offline.");
      const key = this.deps.keyFor(options);
      if (this.active && !this.active.isClosed() && this.activeKey === key) return this.active;
      if (this.opening && this.openingKey === key) return this.opening;
      this.generation += 1;
      const connectGeneration = this.generation;
      this.cancelOpening();
      if (!this.desired || this.deps.keyFor(this.desired) !== key) {
        throw new Error("Connection attempt was cancelled.");
      }
      try {
        return await this.openDesired(this.generation);
      } catch (error) {
        if (this.active && !this.active.isClosed() && this.activeKey === this.deps.keyFor(options)) return this.active;
        if (connectGeneration !== this.generation && this.desired !== null &&
          this.deps.keyFor(this.desired) === this.deps.keyFor(options)) return this.ensureSession(options);
        throw error;
      }
  };
  private adopt = async (options: TOptions, session: SyncpeerSessionHandle) => {
      const key = this.deps.keyFor(options);
      if (!this.desired || this.deps.keyFor(this.desired) !== key || !this.eligible() || session.isClosed()) {
        await session.close().catch(() => undefined);
        return false;
      }
      this.generation += 1;
      this.cancelOpening();
      const previous = this.active;
      this.active = session;
      this.activeKey = key;
      this.connectedAtMs = this.now();
      this.failureStreak = 0;
      this.update({ phase: "connected", attempt: 0, nextRetryAtMs: null, closureReason: null });
      this.watchClosure(session, this.generation);
      this.scheduleUpgrade(this.generation);
      if (previous && previous !== session) await previous.close().catch(() => undefined);
      return true;
  };
  private adoptIncoming = async (options: TOptions, session: SyncpeerSessionHandle) => {
      // No connect attempt is active yet, so eligibility is checked without
      // requiring a desired connection; the incoming session becomes desired.
      if (!this.online || !(this.foreground || this.transferActive) || session.isClosed()) {
        await session.close().catch(() => undefined);
        return false;
      }
      this.desired = options;
      const key = this.deps.keyFor(options);
      this.generation += 1;
      this.cancelOpening();
      const previous = this.active;
      this.active = session;
      this.activeKey = key;
      this.connectedAtMs = this.now();
      this.failureStreak = 0;
      this.update({ phase: "connected", attempt: 0, nextRetryAtMs: null, closureReason: null });
      this.watchClosure(session, this.generation);
      if (previous && previous !== session) await previous.close().catch(() => undefined);
      return true;
  };
  private disconnect = async () => {
      this.desired = null;
      this.generation += 1;
      this.cancelOpening();
      this.update({ phase: "stopping", nextRetryAtMs: null });
      const previous = this.active;
      this.active = null;
      this.activeKey = "";
      await previous?.close().catch(() => undefined);
      this.failureStreak = 0;
      this.update({ ...initialState() });
  };
  private getSession = () => this.active;
  private getState = () => ({ ...this.state });
  private subscribe = (listener: (state: ConnectionLifecycleState) => void) => {
      this.listeners.add(listener);
      listener({ ...this.state });
      return () => this.listeners.delete(listener);
  };
  private setOnline = async (nextOnline: boolean) => {
      this.online = nextOnline;
      if (this.online) await this.attemptNow();
  };
  private setForeground = async (nextForeground: boolean) => {
      this.foreground = nextForeground;
      if (!this.foreground && !this.transferActive) await this.suspend();
      else if (this.foreground) {
        if (!this.desired && this.state.phase === "suspended") {
          this.update({ phase: "idle", nextRetryAtMs: null, closureReason: null });
        }
        await this.attemptNow();
        this.scheduleUpgrade(this.generation);
      }
  };
  private setTransferActive = async (activeTransfer: boolean) => {
      this.transferActive = activeTransfer;
      if (!this.transferActive && !this.foreground) await this.suspend();
      else if (this.transferActive) await this.attemptNow();
      else this.scheduleUpgrade(this.generation);
  };
  api(): ConnectionLifecycle<TOptions> {
    return {
      connect: this.connect,
      adopt: this.adopt,
      adoptIncoming: this.adoptIncoming,
      disconnect: this.disconnect,
      ensureSession: this.ensureSession,
      getSession: this.getSession,
      getState: this.getState,
      subscribe: this.subscribe,
      setOnline: this.setOnline,
      setForeground: this.setForeground,
      setTransferActive: this.setTransferActive,
    };
  }
}

export const createConnectionLifecycle = <TOptions>(deps: ConnectionLifecycleDeps<TOptions>): ConnectionLifecycle<TOptions> =>
  new ConnectionLifecycleRuntime(deps).api();
