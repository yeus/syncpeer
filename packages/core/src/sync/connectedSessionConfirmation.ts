import type { SyncpeerSessionHandle } from "../client.js";
import { sameDeviceId } from "../ui/helpers.js";

/** A new authenticated peer may supersede the originally returned socket
 * during an incoming/outgoing connection race. Acknowledge only the live
 * lifecycle-owned session for the requested peer, never the stale handle.
 */
export const confirmConnectedSession = <T extends Pick<SyncpeerSessionHandle, "remoteDeviceId" | "isClosed">>(
  opened: T,
  active: T | null,
  expectedDeviceId?: string,
): T => {
  if (active && !active.isClosed() &&
    (expectedDeviceId
      ? sameDeviceId(active.remoteDeviceId, expectedDeviceId)
      : active === opened)) return active;
  throw new Error("Peer session was replaced during connection.");
};
