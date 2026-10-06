import { extractDiscoveryAuth, normalizeDiscoveryServerUrl, type SyncpeerHostAdapter,
  type SyncpeerRelayListenOptions, type SyncpeerTlsListener } from "../client.js";
import { discoveryAnnouncementServers } from "../ui/discoveryServer.js";

const wait = (delayMs: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, delayMs);
  signal.addEventListener("abort", done, { once: true });
});

const responseDelay = (headers: Record<string, string> | undefined, name: string, fallback: number) => {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  if (!value) return fallback;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 2_147_483_647) : fallback;
};

const relayPort = (address: string): number => Number(new URL(address).port || 22067);

const poolAddresses = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || !("relays" in payload) || !Array.isArray(payload.relays)) {
    throw new Error("Relay pool response has no relay list.");
  }
  const addresses = [...new Set(payload.relays.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("url" in entry) || typeof entry.url !== "string") return [];
    try {
      const url = new URL(entry.url);
      return url.protocol === "relay:" && url.hostname && !url.username && !url.password && !url.hash &&
        url.searchParams.get("id") ? [url.toString()] : [];
    } catch { return []; }
  }))];
  return [
    ...addresses.filter(address => relayPort(address) === 443),
    ...addresses.filter(address => relayPort(address) !== 443),
  ].slice(0, 32);
};
async function announce(adapter: SyncpeerHostAdapter,
  options: Pick<SyncpeerRelayListenOptions, "certPem" | "keyPem">,
  discoveryServer: string, relayAddress: string, signal: AbortSignal) {
  const url = normalizeDiscoveryServerUrl(discoveryServer);
  const auth = extractDiscoveryAuth(url);
  url.searchParams.delete("device");
  while (!signal.aborted) {
    let delayMs = 60_000;
    try {
      const response = await adapter.discoveryFetch(url, { ...auth, method: "POST", signal,
        certPem: options.certPem, keyPem: options.keyPem,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses: [relayAddress] }) });
      delayMs = responseDelay(response.headers, response.ok ? "reannounce-after" : "retry-after",
        response.ok ? 1_800_000 : 60_000);
      adapter.log?.(response.ok ? "core.relay.announced" : "core.relay.announcement.failed", { status: response.status });
    } catch {
      if (!signal.aborted) adapter.log?.("core.relay.announcement.failed", { category: "transport" });
    }
    await wait(delayMs, signal);
  }
}

async function register(adapter: SyncpeerHostAdapter,
  options: Omit<SyncpeerRelayListenOptions, "relayAddress"> & { poolUrl?: string }, signal: AbortSignal) {
  const poolUrl = new URL(options.poolUrl ?? "https://relays.syncthing.net/endpoint");
  if (poolUrl.protocol !== "https:" || poolUrl.username || poolUrl.password || poolUrl.hash) {
    throw new Error("Relay pools require HTTPS without credentials or fragments.");
  }
  const auth = extractDiscoveryAuth(poolUrl);
  const response = await adapter.discoveryFetch(poolUrl, { ...auth, signal });
  if (!response.ok) {
    await wait(responseDelay(response.headers, "retry-after", 60_000), signal);
    throw new Error("Relay pool request failed.");
  }
  const addresses = poolAddresses(await response.json());
  const groups = [
    addresses.filter(address => relayPort(address) === 443),
    addresses.filter(address => relayPort(address) !== 443),
  ];
  for (const group of groups) {
    const offset = group.length ? (await adapter.randomBytes(1))[0]! % group.length : 0;
    for (let i = 0; i < group.length && !signal.aborted; i++) {
      const relayAddress = group[(offset + i) % group.length]!;
      try {
        const listener = await adapter.listenRelay!({ ...options, relayAddress, signal });
        return { listener, relayAddress };
      } catch { /* Try the next validated candidate; a pool entry can be unavailable. */ }
    }
  }
  throw new Error("Relay registration unavailable.");
}

/** Own one registration and its announcements; accepted sockets use the canonical incoming service. */
export function startAutomaticRelayPresence(adapter: SyncpeerHostAdapter,
  options: Omit<SyncpeerRelayListenOptions, "relayAddress"> & { poolUrl?: string; discoveryServer?: string },
  onAccept: (socket: Awaited<ReturnType<SyncpeerTlsListener["accept"]>>) => void) {
  const stop = new AbortController();
  let listener: SyncpeerTlsListener | undefined;
  const run = async () => {
    let failures = 0;
    while (!stop.signal.aborted) {
      let announced: Promise<void[]> | undefined;
      let registeredAt: number | undefined;
      const registration = new AbortController();
      const cancel = () => registration.abort();
      stop.signal.addEventListener("abort", cancel, { once: true });
      try {
        const ready = await register(adapter, options, stop.signal);
        listener = ready.listener;
        if (!stop.signal.aborted) {
          registeredAt = Date.now();
          adapter.log?.("core.relay.registered", {});
          announced = Promise.all(discoveryAnnouncementServers(options.discoveryServer).map(discoveryServer =>
            announce(adapter, options, discoveryServer, ready.relayAddress, registration.signal)));
          while (!stop.signal.aborted) onAccept(await listener.accept());
        }
      } catch {
        if (registeredAt !== undefined && Date.now() - registeredAt >= 30_000) failures = 0;
        if (!stop.signal.aborted) adapter.log?.("core.relay.presence.failed", { category: "registration" });
      } finally {
        registration.abort();
        await listener?.close().catch(() => undefined);
        listener = undefined;
        await announced;
        stop.signal.removeEventListener("abort", cancel);
      }
      await wait(Math.min(1000 * 2 ** Math.min(failures++, 4), 16_000), stop.signal);
    }
  };
  const running = run();
  return { close: async () => {
    stop.abort();
    const current = listener;
    listener = undefined;
    await current?.close().catch(() => undefined);
    await running;
  } };
}

export function automaticRelayConfiguration(options: { enableRelayFallback?: boolean; quicOnly?: boolean;
  discoveryMode?: "automatic" | "global" | "lan" | "direct"; discoveryServer?: string; relayPoolUrl?: string }) {
  return options.enableRelayFallback !== false && !options.quicOnly &&
    options.discoveryMode !== "lan" && options.discoveryMode !== "direct"
    ? { discoveryServer: options.discoveryServer, poolUrl: options.relayPoolUrl } : undefined;
}
