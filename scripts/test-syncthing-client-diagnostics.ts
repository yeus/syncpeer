type Args = {
  apiUrl: string;
  apiKey?: string;
  configPath?: string;
  deviceId?: string;
  folderId?: string;
  timeoutMs: number;
};

type CheckResult = {
  name: string;
  ok: boolean;
  details: string;
};

const normalizeDeviceId = (value: string): string =>
  value.trim().toUpperCase().replace(/[^A-Z2-7]/g, "");

const parseArgs = (argv: string[]): Args => {
  const out: Args = {
    apiUrl: "http://127.0.0.1:8384",
    apiKey: process.env.SYNCTHING_API_KEY?.trim(),
    timeoutMs: 5_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--api-url") out.apiUrl = String(argv[i + 1] ?? "").trim() || out.apiUrl;
    if (arg === "--api-key") out.apiKey = String(argv[i + 1] ?? "").trim();
    if (arg === "--config") out.configPath = String(argv[i + 1] ?? "").trim();
    if (arg === "--device") out.deviceId = normalizeDeviceId(String(argv[i + 1] ?? ""));
    if (arg === "--folder") out.folderId = String(argv[i + 1] ?? "").trim();
    if (arg === "--timeout-ms") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) out.timeoutMs = Math.floor(value);
    }
  }
  return out;
};

const defaultConfigCandidates = (): string[] => {
  const home = process.env.HOME ?? "";
  return [
    process.env.SYNCTHING_CONFIG ?? "",
    home ? `${home}/.local/state/syncthing/config.xml` : "",
    home ? `${home}/.config/syncthing/config.xml` : "",
    home ? `${home}/Library/Application Support/Syncthing/config.xml` : "",
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Syncthing\\config.xml` : "",
  ].filter((entry) => entry.length > 0);
};

const extractApiKeyFromConfig = (xml: string): string | null => {
  const match = xml.match(/<apikey>([^<]+)<\/apikey>/i);
  return match?.[1]?.trim() || null;
};

const loadApiKey = async (args: Args): Promise<{ apiKey?: string; source: string }> => {
  if (args.apiKey) return { apiKey: args.apiKey, source: "cli/env" };
  const fs = await import("node:fs");
  const candidates = args.configPath ? [args.configPath] : defaultConfigCandidates();
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const xml = fs.readFileSync(candidate, "utf8");
    const key = extractApiKeyFromConfig(xml);
    if (key) return { apiKey: key, source: candidate };
  }
  return { apiKey: undefined, source: "none" };
};

const makeHeaders = (apiKey?: string): Record<string, string> =>
  apiKey ? { "X-API-Key": apiKey } : {};

const fetchJson = async <T>(url: string, apiKey?: string): Promise<T> => {
  const response = await fetch(url, { headers: makeHeaders(apiKey) });
  if (!response.ok) {
    throw new Error(`${url} failed (${response.status})`);
  }
  return (await response.json()) as T;
};

const buildApiUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/g, "")}${path}`;

const run = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const resolvedApi = await loadApiKey(args);
  const apiKey = resolvedApi.apiKey;
  const checks: CheckResult[] = [];

  try {
    const ping = await fetchJson<{ ping?: string }>(
      buildApiUrl(args.apiUrl, "/rest/system/ping"),
      apiKey,
    );
    checks.push({
      name: "api.ping",
      ok: ping.ping === "pong",
      details: `ping=${String(ping.ping ?? "unknown")}`,
    });
  } catch (error) {
    checks.push({
      name: "api.ping",
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  let config: {
    folders?: Array<{ id?: string; devices?: Array<{ deviceID?: string }> }>;
    devices?: Array<{ deviceID?: string }>;
  } | null = null;
  try {
    config = await fetchJson(buildApiUrl(args.apiUrl, "/rest/config"), apiKey);
    const devices = (config.devices ?? []).map((device) => normalizeDeviceId(String(device.deviceID ?? "")));
    checks.push({
      name: "config.devices",
      ok: devices.length > 0,
      details: `count=${devices.length}`,
    });
    if (args.deviceId) {
      checks.push({
        name: "config.device_present",
        ok: devices.includes(args.deviceId),
        details: `device=${args.deviceId}`,
      });
    }
  } catch (error) {
    checks.push({
      name: "config.devices",
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  if (config && args.folderId) {
    const folder = (config.folders ?? []).find((entry) => entry.id === args.folderId);
    checks.push({
      name: "config.folder_present",
      ok: Boolean(folder),
      details: `folder=${args.folderId}`,
    });
    if (folder && args.deviceId) {
      const folderDevices = (folder.devices ?? []).map((entry) =>
        normalizeDeviceId(String(entry.deviceID ?? "")),
      );
      checks.push({
        name: "config.folder_device_present",
        ok: folderDevices.includes(args.deviceId),
        details: `folder=${args.folderId} device=${args.deviceId} folderDevices=${folderDevices.length}`,
      });
    }
  }

  if (args.deviceId) {
    try {
      const discovery = await fetchJson<Record<string, string[]>>(
        buildApiUrl(args.apiUrl, "/rest/system/discovery"),
        apiKey,
      );
      const hit = Object.keys(discovery).find(
        (deviceId) => normalizeDeviceId(deviceId) === args.deviceId,
      );
      checks.push({
        name: "cache.discovery_device_present",
        ok: Boolean(hit),
        details: `device=${args.deviceId} entries=${Object.keys(discovery).length}`,
      });
    } catch (error) {
      checks.push({
        name: "cache.discovery_device_present",
        ok: false,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(
    JSON.stringify(
      {
        args: { ...args, apiKey: apiKey ? "***" : undefined },
        apiKeySource: resolvedApi.source,
        checks,
        failedCount: failed.length,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
