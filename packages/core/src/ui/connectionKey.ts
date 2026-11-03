import type { ConnectOptions } from "./browserClient.js";
import { normalizeDiscoveryServer } from "./discoveryServer.js";

/** One transport/configuration identity for both the browser and Android service lifecycles. */
export const serializeConnectionKey = (
  options: ConnectOptions,
  certPem: string,
  keyPem: string,
  sessionConfigurationRevision = 0,
): string => JSON.stringify({
  host: options.host,
  port: options.port,
  listenPort: options.listenPort ?? 22000,
  discoveryMode: options.discoveryMode ?? "automatic",
  discoveryServer: normalizeDiscoveryServer(options.discoveryServer),
  relayPoolUrl: options.relayPoolUrl,
  enableRelayFallback: options.enableRelayFallback !== false,
  remoteId: options.remoteId ?? "",
  deviceName: options.deviceName,
  certPem,
  keyPem,
  relayOnly: options.relayOnly === true,
  quicOnly: options.quicOnly === true,
  timeoutMs: options.timeoutMs,
  // Folder credentials and the shared-folder set are resolved by the document
  // owner when a session opens. Owner changes increment this revision.
  sharedFolders: options.sharedFolders ?? [],
  sessionConfigurationRevision,
});
