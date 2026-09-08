import type { LocalFolderReplica } from "./replicaIndex.js";

export interface ReplicaState {
  phase: "idle" | "scanning" | "syncing" | "pausing" | "paused" | "resuming" | "error" | "closing" | "closed";
  error?: string;
}

/** Stop new work immediately; let already admitted storage operations finish safely. */
export function createReplicaController(replica: LocalFolderReplica, settings?: {
  paused: boolean;
  savePaused: (paused: boolean) => Promise<void>;
}) {
  let paused = settings?.paused ?? false;
  let stopped = false;
  let closeTask: Promise<void> | undefined;
  let error: string | undefined;
  let transition: Promise<void> | undefined;
  let transitionTarget: boolean | undefined;
  const active = new Map<symbol, "scanning" | "syncing">();
  const listeners = new Set<(state: ReplicaState) => void>();
  const drained = new Set<() => void>();
  const getState = (): ReplicaState => ({
    phase: stopped ? (active.size || transition ? "closing" : "closed") : transition && transitionTarget === false ? "resuming" : paused ? (active.size || transition ? "pausing" : "paused") :
      active.size ? ([...active.values()].includes("syncing") ? "syncing" : "scanning") :
        error ? "error" : "idle",
    ...(error ? { error } : {}),
  });
  const notify = () => {
    for (const listener of listeners) {
      // Presentation failures must not change the outcome of committed storage work.
      try { listener(getState()); } catch { /* Other subscribers still receive the state. */ }
    }
  };
  const run = async <T>(phase: "scanning" | "syncing", operation: () => Promise<T>): Promise<T> => {
    if (stopped) throw new Error("Folder replica is closed.");
    if (paused) throw new Error("Folder synchronization is paused.");
    const token = Symbol();
    active.set(token, phase);
    notify();
    try {
      const result = await operation();
      error = undefined;
      return result;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    } finally {
      active.delete(token);
      if (!active.size) { for (const resolve of drained) resolve(); drained.clear(); }
      notify();
    }
  };
  const persist = (value: boolean, drained: Promise<void>) => {
    const operation = Promise.all([drained, Promise.resolve().then(() => settings?.savePaused(value))]).then(() => {
      paused = value;
      if (!value) error = undefined;
    }, failure => {
      error = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    });
    transition = operation;
    transitionTarget = value;
    const finish = () => { transition = undefined; transitionTarget = undefined; notify(); };
    void operation.then(finish, finish);
    notify();
    return operation;
  };
  return {
    scan: () => run("scanning", replica.scan),
    readBlock: ((...args) => run("syncing", () => replica.readBlock(...args))) as LocalFolderReplica["readBlock"],
    ...(replica.receive ? { receive: ((...args) => run("syncing", () => replica.receive!(...args))) as NonNullable<LocalFolderReplica["receive"]> } : {}),
    ...(replica.edit ? { edit: ((...args) => run("syncing", () => replica.edit!(...args))) as NonNullable<LocalFolderReplica["edit"]> } : {}),
    isPaused: () => paused || stopped,
    close: () => {
      if (closeTask) return closeTask;
      stopped = true;
      const completion = active.size ? new Promise<void>(resolve => drained.add(resolve)) : Promise.resolve();
      closeTask = Promise.allSettled([completion, transition]).then(() => { notify(); });
      notify();
      return closeTask;
    },
    getState,
    subscribe: (listener: (state: ReplicaState) => void) => {
      listeners.add(listener);
      listener(getState());
      return () => { listeners.delete(listener); };
    },
    pause: (): Promise<void> => {
      if (stopped) throw new Error("Folder replica is closed.");
      if (transition) {
        if (transitionTarget) return transition;
        throw new Error("Folder synchronization is still resuming.");
      }
      paused = true;
      const completion = active.size ? new Promise<void>(resolve => drained.add(resolve)) : Promise.resolve();
      return persist(true, completion);
    },
    resume: () => {
      if (stopped) throw new Error("Folder replica is closed.");
      if (transition || (paused && active.size)) throw new Error("Folder synchronization is still pausing.");
      return persist(false, Promise.resolve());
    },
  };
}
