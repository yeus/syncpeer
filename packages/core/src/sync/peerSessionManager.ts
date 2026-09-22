export type PeerConnectionDirection = "incoming" | "outgoing";

export interface ManagedPeerSession {
  close: () => Promise<void>;
  closed: Promise<unknown>;
}

export interface PeerSessionCandidate<T extends ManagedPeerSession = ManagedPeerSession> {
  remoteDeviceId: string;
  direction: PeerConnectionDirection;
  connectionId: string;
  session: T;
}

export interface PeerSessionManager<T extends ManagedPeerSession = ManagedPeerSession> {
  admit: (candidate: PeerSessionCandidate<T>) => Promise<boolean>;
  active: () => PeerSessionCandidate<T>[];
  close: () => Promise<void>;
}

const canonicalId = (value: string) => value.replace(/[^A-Z2-7]/gi, "").toUpperCase();

/** The lower identity dials and the higher identity accepts, so both ends retain the same socket. */
export function preferredPeerDirection(localDeviceId: string, remoteDeviceId: string): PeerConnectionDirection {
  const local = canonicalId(localDeviceId);
  const remote = canonicalId(remoteDeviceId);
  if (!local || !remote || local === remote) throw new Error("Peer identities must be distinct.");
  return local.localeCompare(remote) < 0 ? "outgoing" : "incoming";
}

const candidateWins = (localDeviceId: string, current: PeerSessionCandidate,
  candidate: PeerSessionCandidate) => {
  const preferred = preferredPeerDirection(localDeviceId, candidate.remoteDeviceId);
  if (current.direction !== candidate.direction) return candidate.direction === preferred;
  return candidate.connectionId.localeCompare(current.connectionId) < 0;
};

export function createPeerSessionManager<T extends ManagedPeerSession>(localDeviceId: string): PeerSessionManager<T> {
  const local = canonicalId(localDeviceId);
  if (!local) throw new Error("Local device identity is required.");
  const sessions = new Map<string, PeerSessionCandidate<T>>();
  let transaction = Promise.resolve();
  let closing = false;

  const removeWhenClosed = (key: string, candidate: PeerSessionCandidate<T>) => {
    void candidate.session.closed.finally(() => {
      if (sessions.get(key) === candidate) sessions.delete(key);
    }).catch(() => undefined);
  };

  const admit = (candidate: PeerSessionCandidate<T>): Promise<boolean> => {
    const task = transaction.then(async () => {
      const remote = canonicalId(candidate.remoteDeviceId);
      if (closing || !remote || remote === local || !candidate.connectionId) {
        await candidate.session.close().catch(() => undefined);
        return false;
      }
      const normalized = { ...candidate, remoteDeviceId: remote };
      const current = sessions.get(remote);
      if (current && !candidateWins(local, current, normalized)) {
        await candidate.session.close().catch(() => undefined);
        return false;
      }
      sessions.set(remote, normalized);
      removeWhenClosed(remote, normalized);
      if (current) await current.session.close().catch(() => undefined);
      return true;
    });
    transaction = task.then(() => undefined, () => undefined);
    return task;
  };

  return {
    admit,
    active: () => [...sessions.values()].sort((left, right) =>
      left.remoteDeviceId.localeCompare(right.remoteDeviceId)),
    close: async () => {
      closing = true;
      await transaction;
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(active.map(candidate => candidate.session.close()));
    },
  };
}
