const SYNCTHING_DISCOVERY_ORIGIN = "https://discovery.syncthing.net";
const SYNCTHING_DISCOVERY_SERVER_PIN =
  "LYXKCHX-VI3NYZR-ALCJBHF-WMZYSPK-QG6QJA3-MPFYMSO-U56GTUK-NA2MIAW";
const DEFAULT_DISCOVERY_SERVER =
  `${SYNCTHING_DISCOVERY_ORIGIN}/v2/?id=${SYNCTHING_DISCOVERY_SERVER_PIN}`;

export const getDefaultDiscoveryServer = (): string => DEFAULT_DISCOVERY_SERVER;

export const normalizeDiscoveryServer = (value: string | undefined): string => {
  const raw = (value ?? "").trim();
  if (raw === "") return DEFAULT_DISCOVERY_SERVER;

  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return DEFAULT_DISCOVERY_SERVER;
  }

  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = "/v2/";
  }
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }

  const isOfficialSyncthingDiscovery =
    parsed.protocol === "https:" &&
    parsed.hostname === "discovery.syncthing.net" &&
    parsed.pathname === "/v2/";

  if (isOfficialSyncthingDiscovery && !parsed.searchParams.get("id")) {
    parsed.searchParams.set("id", SYNCTHING_DISCOVERY_SERVER_PIN);
  }

  return parsed.toString();
};
