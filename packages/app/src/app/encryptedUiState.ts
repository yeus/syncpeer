import type { SensitiveAppState } from "./state.ts";

export type EncryptedUiStateStore = {
  /** Load the encrypted UI state once; returns whether it is authoritative. */
  load: () => Promise<boolean>;
  /** Persist the current state after a short debounce. */
  scheduleSave: (payload: SensitiveAppState) => void;
  /** Drop a pending save without writing, e.g. when the app runtime is disposed. */
  cancelPendingSave: () => void;
  isLoaded: () => boolean;
};

/**
 * Owns the encrypted UI-state document (`saveUiState`/`uiState`): saved peers,
 * connection settings and offline snapshots only exist inside the vault.
 *
 * A failed save must not disable persistence for the rest of the session: the
 * user keeps working while the Android document runtime is briefly unavailable,
 * and the next change has to be saved again.
 */
export const createEncryptedUiStateStore = (deps: {
  command: <T>(request: Record<string, unknown>) => Promise<T>;
  readLegacy: () => SensitiveAppState | null;
  apply: (value: unknown) => boolean;
  onFailure: (event: string, error: unknown) => void;
  saveDelayMs?: number;
}): EncryptedUiStateStore => {
  const saveDelayMs = deps.saveDelayMs ?? 500;
  let loaded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const load = async (): Promise<boolean> => {
    if (loaded) return true;
    const stored = await deps.command<unknown>({ operation: "uiState" });
    if (stored !== null && deps.apply(stored)) {
      loaded = true;
      return true;
    }
    if (stored !== null) throw new Error("Invalid encrypted UI state; existing data was retained.");
    const legacy = deps.readLegacy();
    if (!legacy) {
      loaded = true;
      return true;
    }
    await deps.command({ operation: "saveUiState", state: legacy });
    const verified = await deps.command<unknown>({ operation: "uiState" });
    if (JSON.stringify(verified) !== JSON.stringify(JSON.parse(JSON.stringify(legacy)))) {
      throw new Error("Encrypted UI state migration could not be verified.");
    }
    deps.apply(legacy);
    loaded = true;
    return true;
  };

  const scheduleSave = (payload: SensitiveAppState) => {
    if (!loaded) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void deps.command({ operation: "saveUiState", state: payload })
        .catch((error) => deps.onFailure("app.ui_state.save_failed", error));
    }, saveDelayMs);
  };

  return {
    load,
    scheduleSave,
    cancelPendingSave: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
    isLoaded: () => loaded,
  };
};
