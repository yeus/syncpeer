import { resolveNodeLocalDiscovery } from "../packages/core/src/node.ts";
import { setTimeout as sleep } from "node:timers/promises";

function parseArgs(argv: string[]): {
  expectedDeviceId?: string;
  scanMs: number;
  listenPort?: number;
  once: boolean;
  idleLogMs: number;
  apiUrl: string;
  apiKey?: string;
  debug: boolean;
} {
  const out: {
    expectedDeviceId?: string;
    scanMs: number;
    listenPort?: number;
    once: boolean;
    idleLogMs: number;
  } = {
    scanMs: 5000,
    once: false,
    idleLogMs: 5000,
    apiUrl: "http://127.0.0.1:8384",
    debug: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--device" || arg === "--remote-id") {
      out.expectedDeviceId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) out.scanMs = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--listen-port") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) out.listenPort = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--once") {
      out.once = true;
      continue;
    }
    if (arg === "--idle-log-ms") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) out.idleLogMs = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--api-url") {
      out.apiUrl = String(argv[i + 1] ?? "").trim() || out.apiUrl;
      i += 1;
      continue;
    }
    if (arg === "--api-key") {
      out.apiKey = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--debug") {
      out.debug = true;
    }
  }
  if (!out.apiKey) {
    out.apiKey = process.env.SYNCTHING_API_KEY?.trim();
  }
  return out;
}

async function readSyncthingDiscoveryCache(args: {
  apiUrl: string;
  apiKey?: string;
  expectedDeviceId?: string;
}): Promise<Array<{ deviceId: string; from: string; addresses: string[] }>> {
  if (!args.apiKey) return [];
  const url = `${args.apiUrl.replace(/\/+$/g, "")}/rest/system/discovery`;
  const response = await fetch(url, {
    headers: { "X-API-Key": args.apiKey },
  });
  if (!response.ok) {
    throw new Error(`Syncthing API discovery request failed (${response.status})`);
  }
  const json = (await response.json()) as Record<string, string[]>;
  const expected = (args.expectedDeviceId ?? "").trim().toUpperCase();
  return Object.entries(json)
    .filter(([deviceId]) => expected === "" || deviceId.toUpperCase() === expected)
    .map(([deviceId, addresses]) => ({
      deviceId,
      from: "syncthing-cache",
      addresses: Array.isArray(addresses) ? addresses : [],
    }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let stopping = false;
  let activeController: AbortController | null = null;
  let stopMessageShown = false;
  const seen = new Map<string, {
    firstSeenAt: string;
    lastSeenAt: string;
    from: Set<string>;
    addresses: Set<string>;
    hits: number;
  }>();
  process.on("SIGINT", () => {
    if (stopMessageShown) return;
    stopMessageShown = true;
    stopping = true;
    activeController?.abort();
    console.log("\nStopping local discovery watcher...");
  });
  let loop = 0;
  let totalAnnouncements = 0;
  let lastIdleLogAt = 0;
  while (!stopping) {
    loop += 1;
    const startedMs = Date.now();
    const startedAt = new Date().toISOString();
    activeController = new AbortController();
    const result = await resolveNodeLocalDiscovery({
      expectedDeviceId: args.expectedDeviceId,
      timeoutMs: args.scanMs,
      listenPort: args.listenPort,
      signal: activeController.signal,
    });
    activeController = null;
    const payload = (result.payload ?? {}) as {
      timeoutMs?: number;
      socketsBound?: number;
      bindErrors?: Array<{ socket: "udp4" | "udp6"; code: string; message: string }>;
      multicastMembership?: Array<{ socket: "udp6"; iface: string; joined: boolean; error?: string }>;
      stats?: {
        packetsReceived: number;
        packetsBySocket: { udp4: number; udp6: number };
        packetsMagicMismatch: number;
        packetsDecodeFailed: number;
        packetsMissingId: number;
        packetsFilteredByExpectedId: number;
        announcementsAccepted: number;
        announcementsWithNoAddresses: number;
        uniqueSources: string[];
      };
      announcements?: Array<{ deviceId: string; from: string; addresses: string[] }>;
    };
    let announcements = payload.announcements ?? [];
    const bindInUse = (payload.bindErrors ?? []).some((entry) => entry.code === "EADDRINUSE");
    if (bindInUse) {
      try {
        const cacheAnnouncements = await readSyncthingDiscoveryCache({
          apiUrl: args.apiUrl,
          apiKey: args.apiKey,
          expectedDeviceId: args.expectedDeviceId,
        });
        if (cacheAnnouncements.length > 0) {
          announcements = cacheAnnouncements;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (Date.now() - lastIdleLogAt >= args.idleLogMs) {
          console.log(`[${startedAt}] syncthing cache fallback failed: ${message}`);
        }
      }
    }
    totalAnnouncements += announcements.length;
    let changed = false;

    for (const announcement of announcements) {
      const key = announcement.deviceId;
      const existing = seen.get(key);
      const nowIso = new Date().toISOString();
      if (!existing) {
        seen.set(key, {
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          from: new Set([announcement.from]),
          addresses: new Set(announcement.addresses),
          hits: 1,
        });
        changed = true;
        console.log(
          `[${nowIso}] discovered device=${key} from=${announcement.from} addresses=${announcement.addresses.join(",")}`,
        );
        continue;
      }
      existing.lastSeenAt = nowIso;
      existing.hits += 1;
      const fromBefore = existing.from.size;
      const addrBefore = existing.addresses.size;
      existing.from.add(announcement.from);
      for (const address of announcement.addresses) {
        existing.addresses.add(address);
      }
      if (existing.from.size !== fromBefore || existing.addresses.size !== addrBefore) {
        changed = true;
        console.log(
          `[${nowIso}] updated device=${key} from=${[...existing.from].join(",")} addresses=${[...existing.addresses].join(",")}`,
        );
      }
    }

    const nowMs = Date.now();
    if (!changed && nowMs - lastIdleLogAt >= args.idleLogMs) {
      lastIdleLogAt = nowMs;
      const bindSummary = (payload.bindErrors ?? [])
        .map((error) => `${error.socket}:${error.code}`)
        .join(",");
      const mode = bindInUse ? "cache-fallback" : "udp-listen";
      console.log(
        `[${startedAt}] scan#${loop} no new devices (mode=${mode}, announcements=${announcements.length}, knownDevices=${seen.size}, socketsBound=${payload.socketsBound ?? "?"}${bindSummary ? `, bindErrors=${bindSummary}` : ""})`,
      );
      if (args.debug) {
        console.log(
          JSON.stringify(
            {
              scan: loop,
              mode,
              stats: payload.stats ?? null,
              multicastMembership: payload.multicastMembership ?? [],
              bindErrors: payload.bindErrors ?? [],
            },
            null,
            2,
          ),
        );
      }
    }

    if (args.once) break;
    const elapsedMs = Date.now() - startedMs;
    const remainingMs = args.scanMs - elapsedMs;
    if (!stopping && remainingMs > 0) {
      await sleep(remainingMs);
    }
  }

  const summary = [...seen.entries()].map(([deviceId, state]) => ({
    deviceId,
    firstSeenAt: state.firstSeenAt,
    lastSeenAt: state.lastSeenAt,
    hits: state.hits,
    from: [...state.from],
    addresses: [...state.addresses],
  }));
  console.log(JSON.stringify({
    scanMs: args.scanMs,
    listenPort: args.listenPort ?? 21027,
    expectedDeviceId: args.expectedDeviceId ?? null,
    idleLogMs: args.idleLogMs,
    apiUrl: args.apiUrl,
    apiKeyConfigured: !!args.apiKey,
    debug: args.debug,
    knownDeviceCount: summary.length,
    totalAnnouncements,
    devices: summary,
  }, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
