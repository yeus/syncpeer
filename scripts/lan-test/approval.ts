export interface SyncthingApiCall {
  pathname: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export type SyncthingApiRequest = <T>(call: SyncthingApiCall) => Promise<T>;

export interface PendingSyncthingDevice {
  deviceId: string;
  name: string;
  address: string;
}

export const listPendingDevices = async (
  request: SyncthingApiRequest,
): Promise<PendingSyncthingDevice[]> => {
  const pending = await request<Record<string, {
    name?: unknown;
    address?: unknown;
  }>>({ pathname: "/rest/cluster/pending/devices" });
  return Object.entries(pending).map(([deviceId, details]) => ({
    deviceId,
    name: typeof details.name === "string" ? details.name : "",
    address: typeof details.address === "string" ? details.address : "",
  }));
};

export const waitForPendingDeviceChange = async (
  since: number,
  request: SyncthingApiRequest,
  signal?: AbortSignal,
): Promise<number> => {
  const query = new URLSearchParams({
    since: String(since),
    events: "PendingDevicesChanged",
    timeout: "60",
  });
  const events = await request<Array<{ id?: unknown }>>({
    pathname: "/rest/events?" + query,
    ...(signal ? { signal } : {}),
  });
  const latest = events.at(-1)?.id;
  return typeof latest === "number" ? latest : since;
};

export const approvePendingDevice = async (
  args: {
    deviceId: string;
    deviceName: string;
    folderId: string;
    untrusted?: boolean;
    encryptionPassword?: string;
  },
  request: SyncthingApiRequest,
): Promise<void> => {
  const defaults = await request<Record<string, unknown>>({
    pathname: "/rest/config/defaults/device",
  });
  await request({
    pathname: "/rest/config/devices",
    method: "POST",
    body: {
      ...defaults,
      deviceID: args.deviceId,
      name: args.deviceName,
      untrusted: args.untrusted ?? false,
    },
  });

  const folder = await request<Record<string, unknown> & {
    devices?: Array<Record<string, unknown> & { deviceID?: string }>;
  }>({ pathname: "/rest/config/folders/" + encodeURIComponent(args.folderId) });
  const devices = folder.devices ?? [];
  if (devices.some((device) => device.deviceID === args.deviceId)) return;
  await request({
    pathname: "/rest/config/folders/" + encodeURIComponent(args.folderId),
    method: "PUT",
    body: {
      ...folder,
      devices: [
        ...devices,
        {
          deviceID: args.deviceId,
          introducedBy: "",
          encryptionPassword: args.encryptionPassword ?? "",
        },
      ],
    },
  });
};
