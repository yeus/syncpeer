import type { createReplicaController, ReplicaState } from "./replicaControl.js";
import type { LocalFolderReplica } from "./replicaIndex.js";

export interface FolderRegistration {
  id: string;
  label: string;
  /** Host-owned opaque storage reference, not a password or a peer address. */
  storageId: string;
  /** Explicit opt-in: this service is the cache owner for this folder. */
  downloads?: boolean;
}

export interface RegisteredFolderState extends FolderRegistration {
  phase: ReplicaState["phase"] | "opening";
  error?: string;
}

export interface OpenedFolder {
  replica: ReturnType<typeof createReplicaController>;
  close: () => Promise<void>;
}

const validateRegistrations = (values: FolderRegistration[]) => {
  if (!Array.isArray(values)) throw new Error("Invalid folder registrations.");
  const ids = new Set<string>(), roots = new Set<string>();
  return values.map(value => {
    if (!value || [value.id, value.label, value.storageId].some(part => typeof part !== "string" || !part.trim() || part !== part.trim())) {
      throw new Error("Invalid folder registration.");
    }
    if (ids.has(value.id)) throw new Error("Folder is already registered.");
    if (roots.has(value.storageId)) throw new Error("Storage root is already registered.");
    ids.add(value.id); roots.add(value.storageId);
    if (value.downloads !== undefined && typeof value.downloads !== "boolean") throw new Error("Invalid download registration.");
    return { id: value.id, label: value.label, storageId: value.storageId, ...(value.downloads ? { downloads: true } : {}) };
  });
};

/** One lifecycle owner per profile; persistence and unlocking stay at host boundaries. */
export function createFolderRegistry(dependencies: {
  load: () => Promise<FolderRegistration[]>;
  save: (folders: FolderRegistration[]) => Promise<void>;
  open: (folder: FolderRegistration, signal: AbortSignal) => Promise<OpenedFolder>;
}) {
  const entries = new Map<string, { config: FolderRegistration; state: ReplicaState | { phase: "opening"; error?: string };
    opened?: OpenedFolder; unsubscribe?: () => void }>();
  const listeners = new Set<(folders: RegisteredFolderState[]) => void>();
  const shutdown = new AbortController();
  let initialized = false;
  let queue = Promise.resolve();
  let closeTask: Promise<void> | undefined;
  const getState = (): RegisteredFolderState[] => [...entries.values()].map(entry => ({ ...entry.config, ...entry.state }));
  const notify = () => {
    for (const listener of listeners) { try { listener(getState()); } catch { /* Rendering cannot invalidate storage work. */ } }
  };
  const enqueue = <T>(operation: () => Promise<T>) => {
    const task = queue.then(async () => {
      if (shutdown.signal.aborted) throw new Error("Folder registry is closed.");
      return operation();
    });
    queue = task.then(() => {}, () => {});
    return task;
  };
  const requireEntry = (id: string) => {
    if (!initialized) throw new Error("Folder registry is not initialized.");
    const entry = entries.get(id);
    if (!entry) throw new Error("Folder is not registered.");
    return entry;
  };
  const stopEntry = async (entry: ReturnType<typeof requireEntry>) => {
    if (!entry.opened) return;
    entry.unsubscribe?.(); entry.unsubscribe = undefined;
    entry.state = { phase: "closing" }; notify();
    try {
      await entry.opened.replica.close();
      await entry.opened.close();
      entry.opened = undefined;
      entry.state = { phase: "closed" }; notify();
    } catch (error) {
      entry.state = { phase: "error", error: error instanceof Error ? error.message : String(error) }; notify();
      throw error;
    }
  };
  const openEntry = async (id: string) => {
    const entry = requireEntry(id);
    if (entry.opened) {
      if (entry.opened.replica.getState().phase !== "closed") return;
      await stopEntry(entry);
    }
    entry.state = { phase: "opening" }; notify();
    try {
      const opened = await dependencies.open({ ...entry.config }, shutdown.signal);
      entry.opened = opened;
      if (shutdown.signal.aborted) { await stopEntry(entry); shutdown.signal.throwIfAborted(); }
      entry.unsubscribe = opened.replica.subscribe(state => { entry.state = state; notify(); });
    } catch (error) {
      entry.state = shutdown.signal.aborted && !entry.opened ? { phase: "closed" }
        : { phase: "error", error: error instanceof Error ? error.message : String(error) }; notify();
      throw error;
    }
  };
  return {
    getState,
    subscribe: (listener: (folders: RegisteredFolderState[]) => void) => {
      listeners.add(listener); listener(getState());
      return () => { listeners.delete(listener); };
    },
    initialize: () => enqueue(async () => {
      if (initialized) return;
      const configs = validateRegistrations(await dependencies.load());
      for (const config of configs) entries.set(config.id, { config, state: { phase: "closed" } });
      initialized = true; notify();
    }),
    add: (config: FolderRegistration) => enqueue(async () => {
      if (!initialized) throw new Error("Folder registry is not initialized.");
      const configs = validateRegistrations([...entries.values()].map(entry => entry.config).concat(config));
      const added = { ...configs.at(-1)! };
      await dependencies.save(configs);
      entries.set(added.id, { config: added, state: { phase: "closed" } }); notify();
      await openEntry(added.id);
    }),
    open: (id: string) => enqueue(() => openEntry(id)),
    attachDownloads: (id: string) => enqueue(async () => {
      const entry = requireEntry(id);
      const config = { ...entry.config, downloads: true };
      await dependencies.save([...entries.values()].map(value => value === entry ? config : value.config));
      entry.config = config; notify();
    }),
    getReplica: (id: string): LocalFolderReplica | undefined => requireEntry(id).opened?.replica,
    pause: (id: string) => enqueue(async () => {
      const opened = requireEntry(id).opened;
      if (!opened) throw new Error("Folder is not open.");
      await opened.replica.pause();
    }),
    resume: (id: string) => enqueue(async () => {
      const opened = requireEntry(id).opened;
      if (!opened) throw new Error("Folder is not open.");
      await opened.replica.resume();
    }),
    /** Forget configuration only; never delete local or remote data implicitly. */
    detach: (id: string) => enqueue(async () => {
      const entry = requireEntry(id);
      await stopEntry(entry);
      await dependencies.save([...entries.values()].filter(value => value !== entry).map(value => ({ ...value.config })));
      entries.delete(id); notify();
    }),
    close: () => {
      shutdown.abort();
      closeTask ??= (async () => {
        await queue;
        const results = await Promise.allSettled([...entries.values()].map(stopEntry));
        const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, "Some folder resources could not be closed.");
      })().catch(error => { closeTask = undefined; throw error; });
      return closeTask;
    },
  };
}
