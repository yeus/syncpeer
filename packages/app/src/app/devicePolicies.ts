import {
  isValidSyncthingDeviceId,
  normalizeDeviceId,
  sameDeviceId,
} from "@syncpeer/core/browser";
import {
  advertisedDevices,
  isIntroducerDevice,
  type AppState,
} from "./state.ts";
import { temporarySavedDeviceName } from "./suggestedNames.ts";

const sortByName = <T extends { name: string }>(items: T[]) =>
  [...items].sort((left, right) => left.name.localeCompare(right.name));

export const normalizeCandidateDeviceId = (deviceId: string) =>
  normalizeDeviceId(deviceId);

export const normalizeCandidateAddresses = (addresses: string[]) =>
  [...new Set(addresses.map((item) => String(item ?? "").trim()).filter(Boolean))].sort();

export const parseTcpAddress = (
  address: string,
): { host: string; port: number } | null => {
  const trimmed = String(address ?? "").trim();
  if (!trimmed.startsWith("tcp://")) return null;
  try {
    const parsed = new URL(trimmed);
    const port = Number(parsed.port);
    if (!parsed.hostname || !Number.isFinite(port) || port <= 0) return null;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
};

export const suggestedSavedDeviceName = (state: AppState, deviceId: string) => {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) return "";
  const advertised = advertisedDevices(state).find((item) => sameDeviceId(item.id, normalized));
  if (advertised?.name.trim()) return advertised.name.trim();
  const existing = state.devices.savedDevices.find((item) => sameDeviceId(item.id, normalized));
  if (existing?.name.trim()) return existing.name.trim();
  return temporarySavedDeviceName(normalized);
};

export const upsertSavedDevice = (
  state: AppState,
  deviceId: string,
  name?: string,
  options?: { customName?: boolean; isIntroducer?: boolean },
) => {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) return false;
  const existing = state.devices.savedDevices.find((item) => item.id === normalized);
  const nextEntry = {
    id: normalized,
    name: (name ?? "").trim() || temporarySavedDeviceName(normalized),
    createdAtMs: existing?.createdAtMs ?? Date.now(),
    isIntroducer: options?.isIntroducer ?? existing?.isIntroducer ?? false,
    customName: options?.customName ?? existing?.customName ?? false,
  };
  state.devices.savedDevices = sortByName(
    existing
      ? state.devices.savedDevices.map((item) =>
          item.id === normalized ? nextEntry : item,
        )
      : [...state.devices.savedDevices, nextEntry],
  );
  return true;
};

export const syncConnectedDeviceSavedName = (
  state: AppState,
  deviceId: string,
  advertisedName?: string,
) => {
  const normalized = normalizeDeviceId(deviceId);
  const nextName = (advertisedName ?? "").trim();
  if (!normalized || !nextName) return;
  const existing = state.devices.savedDevices.find((item) =>
    sameDeviceId(item.id, normalized),
  );
  if (!existing || existing.customName || existing.name.trim() === nextName) return;
  upsertSavedDevice(state, normalized, nextName, { customName: false });
};

export const applyAutoApprovals = (
  state: AppState,
  sourceDeviceId: string,
  advertisedFolders: Array<{ key: string }>,
) => {
  const sourceIsIntroducer = isIntroducerDevice(state, sourceDeviceId);
  if (state.connection.autoAcceptNewDevices) {
    for (const device of advertisedDevices(state)) {
      if (device.accepted || !isValidSyncthingDeviceId(device.id)) continue;
      upsertSavedDevice(state, device.id, device.name);
    }
  }
  if (state.connection.autoAcceptIntroducedFolders && sourceIsIntroducer) {
    const next = new Set(state.approvals.syncApprovedFolderKeys);
    for (const folder of advertisedFolders) {
      next.add(folder.key);
    }
    state.approvals.syncApprovedFolderKeys = next;
  }
};
