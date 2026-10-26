// Shared stream RPC copied from Taskyon packages/protocol/src/index.ts (2026-10-25).
import type { Port } from "./frpBus.js";
import { awaitRequestResponse, type RequestResult } from "./requestLifecycle.js";

export type RpcMessagePort<Tx, Rx = unknown> = Pick<Port<Tx, Rx>, "send" | "receive">;
export type RpcResponseResult<T> = RequestResult<T>;
export type RpcScopeStore<TScope> = {
  set: (requestId: string, scope: TScope) => void;
  get: (requestId: string) => TScope | undefined;
  delete: (requestId: string) => void;
};
export function createRpcScopeStore<TScope>(): RpcScopeStore<TScope> {
  const scopes = new Map<string, TScope>();
  return {
    set: (requestId, scope) => { scopes.set(requestId, scope); },
    get: requestId => scopes.get(requestId),
    delete: requestId => { scopes.delete(requestId); },
  };
}

export function createStreamRpcRequest<
  TRequest,
  TResponse,
  TResult,
  TScope,
  TReceive = unknown,
>(options: {
  port: RpcMessagePort<TRequest, TReceive>
  request: TRequest
  requestId: string
  timeoutMs: number
  signal?: AbortSignal | undefined
  scope?: TScope | undefined
  scopeStore?: RpcScopeStore<TScope> | undefined
  createCancelRequest?: ((reason: string) => TRequest) | undefined
  parseResponse: (message: TReceive) => TResponse | undefined
  isResponseForRequest: (response: TResponse, requestId: string) => boolean
  readResponse: (response: TResponse) => RpcResponseResult<TResult>
}): Promise<TResult> {
  if (options.scope !== undefined) options.scopeStore?.set(options.requestId, options.scope)
  const createCancelRequest = options.createCancelRequest
  return awaitRequestResponse({
    subscribe: options.port.receive,
    sendRequest: () => options.port.send(options.request),
    requestLabel: options.requestId,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    sendCancel: createCancelRequest
      ? (reason) => options.port.send(createCancelRequest(reason))
      : undefined,
    readResponse: (message) => {
      const response = options.parseResponse(message)
      if (!response || !options.isResponseForRequest(response, options.requestId)) return undefined
      return options.readResponse(response)
    },
  }).finally(() => options.scopeStore?.delete(options.requestId))
}
