import { createStreamRpcRequest } from "../transfer/frpRpc.js";
import { createPortFromTransport } from "../transfer/frpTransport.js";

type SessionRequest = {
  type: "session.request" | "session.cancel";
  requestId: string;
  command?: Record<string, unknown>;
};
type SessionReply = {
  type: "session.reply";
  requestId: string;
  result?: unknown;
  error?: string;
};

/** Transport-neutral Taskyon-style RPC over an Android service-command adapter.
 * The service remains the only owner of the peer TLS/QUIC session.
 */
export const createServiceSessionRpcClient = (
  invoke: (command: Record<string, unknown>) => Promise<unknown>,
) => {
  const listeners = new Set<(reply: SessionReply) => void>();
  let closed = false;
  let serial = 0;
  const transport = createPortFromTransport<SessionRequest, SessionReply>({
    send: message => {
      if (message.type !== "session.request" || !message.command) return;
      void invoke(message.command).then(
        result => {
          if (!closed) for (const listener of listeners) listener({
            type: "session.reply", requestId: message.requestId, result,
          });
        },
        error => {
          if (!closed) for (const listener of listeners) listener({
            type: "session.reply", requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });

  return {
    call: (command: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 75_000) => {
      if (closed) return Promise.reject(new Error("Service session RPC client is closed."));
      const requestId = String(++serial);
      return createStreamRpcRequest<SessionRequest, SessionReply, unknown, never, SessionReply>({
        port: transport.port,
        requestId,
        request: { type: "session.request", requestId, command },
        timeoutMs,
        signal,
        createCancelRequest: () => ({ type: "session.cancel", requestId }),
        parseResponse: reply => reply.type === "session.reply" ? reply : undefined,
        isResponseForRequest: (reply, expected) => reply.requestId === expected,
        readResponse: reply => reply.error !== undefined
          ? { ok: false, error: new Error(reply.error) }
          : { ok: true, value: reply.result },
      });
    },
    close: () => { closed = true; transport.destroy(); listeners.clear(); },
  };
};
