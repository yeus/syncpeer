import type { ServiceSessionPhase, SessionState } from "@syncpeer/core/browser";

type ConnectionStatusInput = {
  phase: SessionState["phase"];
  connected: boolean;
  peerPhase?: ServiceSessionPhase | null;
  paused: boolean;
};

/** Shared by the header badge and its regression test. */
export const connectionStatusLabel = (input: ConnectionStatusInput): string => {
  if (input.connected) {
    if (input.peerPhase === "reconnecting") return "Reconnecting";
    if (input.peerPhase === "waiting") return "Waiting";
    if (input.peerPhase === "error") return "Connection error";
    if (input.peerPhase === "suspended") return "Suspended";
    return "Connected";
  }
  if (input.paused) return "Paused";
  if (input.phase === "connecting") return "Connecting";
  if (input.phase === "reconnecting") return "Reconnecting";
  if (input.phase === "waiting") return "Retry scheduled";
  if (input.phase === "suspended") return "Suspended";
  if (input.phase === "stopping") return "Stopping";
  if (input.phase === "error") return "Connection error";
  return "Disconnected";
};

export const connectionStatusTone = (
  input: ConnectionStatusInput,
): "online" | "offline" | "error" => {
  if (input.connected && (!input.peerPhase || input.peerPhase === "connected" ||
    input.peerPhase === "starting")) return "online";
  return input.phase === "error" || input.peerPhase === "error" ? "error" : "offline";
};
