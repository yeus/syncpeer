const SYNCTHING_LEGACY_DISCOVERY_HOST = "discovery.syncthing.net";
const SYNCTHING_DISCOVERY_LOOKUP_HOST = "discovery-lookup.syncthing.net";
const DEFAULT_DISCOVERY_SERVER =
  `https://${SYNCTHING_DISCOVERY_LOOKUP_HOST}/v2/?noannounce`;
const DEFAULT_DISCOVERY_ANNOUNCEMENT_SERVERS = [
  "https://discovery-announce-v4.syncthing.net/v2/?nolookup",
  "https://discovery-announce-v6.syncthing.net/v2/?nolookup",
] as const;

export const getDefaultDiscoveryServer = (): string => DEFAULT_DISCOVERY_SERVER;

const normalizeUrl = (raw: string): URL | null => {
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = "/v2/";
    if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
    return parsed;
  } catch {
    return null;
  }
};

const isOfficialDefaultLookup = (parsed: URL): boolean =>
  parsed.protocol === "https:" &&
  parsed.pathname === "/v2/" &&
  (parsed.hostname === SYNCTHING_LEGACY_DISCOVERY_HOST ||
    parsed.hostname === SYNCTHING_DISCOVERY_LOOKUP_HOST);

export const normalizeDiscoveryServer = (value: string | undefined): string => {
  const raw = (value ?? "").trim();
  if (raw === "") return DEFAULT_DISCOVERY_SERVER;
  const parsed = normalizeUrl(raw);
  if (!parsed) return DEFAULT_DISCOVERY_SERVER;
  if (isOfficialDefaultLookup(parsed)) return DEFAULT_DISCOVERY_SERVER;
  return parsed.toString();
};

export const discoveryAnnouncementServers = (value: string | undefined): readonly string[] => {
  const normalized = normalizeDiscoveryServer(value);
  const parsed = new URL(normalized);
  return parsed.hostname === SYNCTHING_DISCOVERY_LOOKUP_HOST && parsed.pathname === "/v2/"
    ? DEFAULT_DISCOVERY_ANNOUNCEMENT_SERVERS
    : [normalized];
};