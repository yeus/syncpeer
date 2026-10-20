import {
  createTransferNotificationState,
  cachedFileKey,
  reduceTransferNotification,
  transferNotificationView,
  type ActiveTransfer,
  type SyncpeerBrowserClient,
} from "@syncpeer/core/browser";
import { addPluginListener } from "@tauri-apps/api/core";
import {
  createChannel as createNativeNotificationChannel,
  Importance as NativeNotificationImportance,
  isPermissionGranted as isNativeNotificationPermissionGranted,
  onAction as onNativeNotificationAction,
  registerActionTypes as registerNativeNotificationActionTypes,
  removeActive as removeActiveNativeNotifications,
  requestPermission as requestNativeNotificationPermission,
  sendNotification as sendNativeNotification,
} from "@tauri-apps/plugin-notification";
import { supportsOngoingTransferNotifications } from "../lib/runtimeInfo.ts";
import { reportActionError } from "./actionErrors.ts";
import type { AppState } from "./state.ts";

const NOTIFICATION_ID = 22067;
const CHANNEL_ID = "syncpeer-transfers-v2";
const ACTION_TYPE = "syncpeer-transfer";
const CANCEL_ACTION = "cancel";
const UPDATE_INTERVAL_MS = 1000;

interface PendingNotification {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly ongoing: boolean;
  readonly force: boolean;
  readonly progressPercent?: number;
  readonly cancellable: boolean;
}

type TransferRuntimeArgs = {
  state: AppState;
  client: SyncpeerBrowserClient;
  runtimeSurface: "cli" | "desktop-ui" | "android-ui" | "web-ui";
};

type TransferRuntimeState = ReturnType<typeof createTransferNotificationState>;

type TransferRuntimeControl = {
  downloadNoticeTimer: number | null;
  lastNotificationAtMs: number;
  permissionRequested: boolean;
  notificationSetup: Promise<void> | null;
  notificationTimer: ReturnType<typeof setTimeout> | null;
  notificationInFlight: Promise<void> | null;
  pendingNotification: PendingNotification | null;
  transferState: TransferRuntimeState;
  cancellations: Map<string, { direction: ActiveTransfer["direction"]; cancel: () => void }>;
  runtimeStarted: boolean;
  runtimeTransition: Promise<void>;
};

export const createTransferRuntime = (args: TransferRuntimeArgs) => {
  const control: TransferRuntimeControl = {
    downloadNoticeTimer: null,
    lastNotificationAtMs: 0,
    permissionRequested: false,
    notificationSetup: null,
    notificationTimer: null,
    notificationInFlight: null,
    pendingNotification: null,
    transferState: createTransferNotificationState(),
    cancellations: new Map(),
    runtimeStarted: false,
    runtimeTransition: Promise.resolve(),
  };
  return {
    begin: (transfer: ActiveTransfer, cancel: () => void) =>
      begin(args, control, transfer, cancel),
    update: (id: string, completedBytes: number, totalBytes: number) =>
      update(args, control, id, completedBytes, totalBytes),
    finish: (id: string, outcome: "completed" | "failed" | "cancelled") =>
      finish(args, control, id, outcome),
    setDownloadNotice: (message: string, clearAfterMs = 0) =>
      setDownloadNotice(args, control, message, clearAfterMs),
    setActiveDownload: (
      key: string,
      value: { name: string; text: string; progressPercent: number },
    ) => setActiveDownload(args, key, value),
    clearActiveDownload: (key: string) => clearActiveDownload(args, key),
    cancelDownload: (folderId?: string, path?: string) =>
      cancelDownload(args, control, folderId, path),
    cancelAll: () => cancelAll(control),
    transferInProgress: () => transferInProgress(args),
    hasActiveDirection: (direction: ActiveTransfer["direction"]) =>
      hasActiveDirection(control, direction),
    dispose: () => dispose(control),
  };
};

  const cancelAll = (control: TransferRuntimeControl) => {
    for (const transfer of control.cancellations.values()) transfer.cancel();
  };

  const ensurePermission = async (control: TransferRuntimeControl) => {
    try {
      if (await isNativeNotificationPermissionGranted()) return true;
      if (control.permissionRequested) return false;
      control.permissionRequested = true;
      return (await requestNativeNotificationPermission()) === "granted";
    } catch {
      return false;
    }
  };

  const ensureNotificationSetup = (args: TransferRuntimeArgs, control: TransferRuntimeControl) => {
    if (!supportsOngoingTransferNotifications(args.runtimeSurface)) {
      return Promise.resolve();
    }
    if (!control.notificationSetup) {
      control.notificationSetup = (async () => {
        if (args.client.updateTransferNotification) {
          await addPluginListener<{ actionId?: string; notification?: { id?: number } }>(
            "syncpeer-android",
            "transferAction",
            (event) => {
              if (
                event.actionId === CANCEL_ACTION &&
                Number(event.notification?.id) === NOTIFICATION_ID
              ) {
                cancelAll(control);
              }
            },
          );
          return;
        }
        await createNativeNotificationChannel({
          id: CHANNEL_ID,
          name: "Syncpeer transfers",
          description: "File transfer progress",
          importance: NativeNotificationImportance.Low,
          vibration: false,
          lights: false,
        });
        await registerNativeNotificationActionTypes([
          {
            id: ACTION_TYPE,
            actions: [{ id: CANCEL_ACTION, title: "Cancel" }],
          },
        ]);
        await onNativeNotificationAction((event) => {
          const data = event as unknown as {
            actionId?: string;
            notification?: { id?: number };
          };
          if (
            data.actionId === CANCEL_ACTION &&
            Number(data.notification?.id) === NOTIFICATION_ID
          ) {
            cancelAll(control);
          }
        });
      })().catch(() => undefined);
    }
    return control.notificationSetup;
  };

  const flushNotification = async (args: TransferRuntimeArgs, control: TransferRuntimeControl) => {
    if (control.notificationInFlight || !control.pendingNotification) return;
    const next = control.pendingNotification;
    control.pendingNotification = null;
    control.notificationInFlight = (async () => {
      await ensureNotificationSetup(args, control);
      if (!(await ensurePermission(control))) return;
      const android = supportsOngoingTransferNotifications(args.runtimeSurface);
      try {
        if (android && args.client.updateTransferNotification) {
          await args.client.updateTransferNotification({
            title: next.title,
            body: next.body,
            progress: next.progressPercent,
            ongoing: next.ongoing,
            cancellable: next.cancellable,
          });
        } else {
          sendNativeNotification({
            id: next.id,
            title: next.title,
            body: next.body,
            ...(android
              ? {
                  channelId: CHANNEL_ID,
                  ...(next.ongoing && next.cancellable
                    ? { actionTypeId: ACTION_TYPE }
                    : {}),
                }
              : {}),
            ongoing: next.ongoing,
            autoCancel: !next.ongoing,
            silent: true,
          });
        }
        control.lastNotificationAtMs = Date.now();
      } catch {
        // Notifications are best-effort.
      }
    })().finally(() => {
      control.notificationInFlight = null;
      if (!control.pendingNotification) return;
      const elapsed = Date.now() - control.lastNotificationAtMs;
      if (control.pendingNotification.force || elapsed >= UPDATE_INTERVAL_MS) {
        void flushNotification(args, control);
      } else if (!control.notificationTimer) {
        control.notificationTimer = setTimeout(() => {
          control.notificationTimer = null;
          void flushNotification(args, control);
        }, UPDATE_INTERVAL_MS - elapsed);
      }
    });
    await control.notificationInFlight;
  };

  const showNotification = async (
    args: TransferRuntimeArgs,
    control: TransferRuntimeControl,
    title: string,
    body: string,
    options?: {
      ongoing?: boolean;
      force?: boolean;
      progress?: boolean;
      progressPercent?: number;
      cancellable?: boolean;
    },
  ) => {
    if (
      options?.progress &&
      !supportsOngoingTransferNotifications(args.runtimeSurface)
    ) {
      return;
    }
    control.pendingNotification = {
      id: NOTIFICATION_ID,
      title,
      body,
      ongoing: options?.ongoing ?? true,
      force: options?.force ?? false,
      progressPercent: options?.progressPercent,
      cancellable: options?.cancellable ?? false,
    };
    const elapsed = Date.now() - control.lastNotificationAtMs;
    if (
      options?.force ||
      (!control.notificationInFlight && elapsed >= UPDATE_INTERVAL_MS)
    ) {
      await flushNotification(args, control);
      return;
    }
    if (!control.notificationTimer) {
      control.notificationTimer = setTimeout(() => {
        control.notificationTimer = null;
        void flushNotification(args, control);
      }, Math.max(0, UPDATE_INTERVAL_MS - elapsed));
    }
  };

  const clearNotification = async (args: TransferRuntimeArgs, control: TransferRuntimeControl) => {
    if (!supportsOngoingTransferNotifications(args.runtimeSurface)) return;
    control.pendingNotification = null;
    if (control.notificationTimer) clearTimeout(control.notificationTimer);
    control.notificationTimer = null;
    if (control.notificationInFlight) await control.notificationInFlight.catch(() => undefined);
    if (control.transferState.active.length > 0) return;
    try {
      await args.client.stopTransfer?.();
    } catch {
      // Runtime transition failures were already reported.
    }
    try {
      await removeActiveNativeNotifications([{ id: NOTIFICATION_ID }]);
    } catch {
      // Notifications are best-effort.
    }
  };

  const reconcileRuntime = (args: TransferRuntimeArgs, control: TransferRuntimeControl) => {
    control.runtimeTransition = control.runtimeTransition
      .catch(() => undefined)
      .then(async () => {
        const shouldRun = control.transferState.active.length > 0;
        if (shouldRun === control.runtimeStarted) return;
        control.runtimeStarted = shouldRun;
        try {
          if (shouldRun) {
            await args.client.startTransfer?.(
              control.transferState.active.length === 1
                ? control.transferState.active[0].label
                : `${control.transferState.active.length} transfers`,
            );
          } else {
            await args.client.stopTransfer?.();
          }
        } catch (error) {
          control.runtimeStarted = false;
          reportActionError(
            args.state,
            shouldRun
              ? "transfer_runtime.start_failed"
              : "transfer_runtime.stop_failed",
            error,
          );
        }
      });
    return control.runtimeTransition;
  };

  const renderNotification = async (
    args: TransferRuntimeArgs,
    control: TransferRuntimeControl,
    force = false,
  ) => {
    const view = transferNotificationView(control.transferState);
    if (!view) {
      await clearNotification(args, control);
      return;
    }
    await showNotification(args, control, view.title, view.body, {
      ongoing: view.ongoing,
      force,
      progress: view.ongoing,
      progressPercent: view.progress,
      cancellable: view.cancellable,
    });
  };

  const begin = async (
    args: TransferRuntimeArgs,
    control: TransferRuntimeControl,
    transfer: ActiveTransfer,
    cancel: () => void,
  ) => {
    control.transferState = reduceTransferNotification(control.transferState, {
      type: "begin",
      transfer,
    });
    control.cancellations.set(transfer.id, { direction: transfer.direction, cancel });
    await reconcileRuntime(args, control);
    await renderNotification(args, control, true);
  };

  const update = (
    args: TransferRuntimeArgs,
    control: TransferRuntimeControl,
    id: string,
    completedBytes: number,
    totalBytes: number,
  ) => {
    control.transferState = reduceTransferNotification(control.transferState, {
      type: "progress",
      id,
      completedBytes,
      totalBytes,
    });
    void renderNotification(args, control);
  };

  const finish = async (
    args: TransferRuntimeArgs,
    control: TransferRuntimeControl,
    id: string,
    outcome: "completed" | "failed" | "cancelled",
  ) => {
    control.cancellations.delete(id);
    control.transferState = reduceTransferNotification(control.transferState, {
      type: "finish",
      id,
      outcome,
    });
    await reconcileRuntime(args, control);
    await renderNotification(args, control, true);
  };

  const setDownloadNotice = (
    args: TransferRuntimeArgs,
    control: TransferRuntimeControl,
    message: string,
    clearAfterMs = 0,
  ) => {
    args.state.ui.downloadNotice = message;
    if (control.downloadNoticeTimer) clearTimeout(control.downloadNoticeTimer);
    control.downloadNoticeTimer = null;
    if (clearAfterMs > 0 && typeof window !== "undefined") {
      control.downloadNoticeTimer = window.setTimeout(() => {
        args.state.ui.downloadNotice = "";
        control.downloadNoticeTimer = null;
      }, clearAfterMs);
    }
  };

  const setActiveDownload = (
    args: TransferRuntimeArgs,
    key: string,
    value: { name: string; text: string; progressPercent: number },
  ) => {
    args.state.favorites.activeDownloads = {
      ...args.state.favorites.activeDownloads,
      [key]: {
        ...value,
        progressPercent: Math.max(0, Math.min(100, value.progressPercent)),
      },
    };
    args.state.favorites.isDownloading = true;
  };

  const clearActiveDownload = (args: TransferRuntimeArgs, key: string) => {
    const remaining = { ...args.state.favorites.activeDownloads };
    delete remaining[key];
    args.state.favorites.activeDownloads = remaining;
    args.state.favorites.isDownloading = Object.keys(remaining).length > 0;
  };

  const cancelDownload = (
    args: TransferRuntimeArgs,
    control: TransferRuntimeControl,
    folderId?: string,
    path?: string,
  ) => {
    if (!args.state.favorites.isDownloading) return;
    if (folderId !== undefined && path !== undefined) {
      control.cancellations.get(`download:${cachedFileKey(folderId, path)}`)?.cancel();
      return;
    }
    for (const transfer of control.cancellations.values()) {
      if (transfer.direction === "download") transfer.cancel();
    }
  };

  const transferInProgress = (args: TransferRuntimeArgs) =>
    Object.keys(args.state.favorites.activeDownloads).length > 0 ||
    args.state.ui.uploadProgressActive ||
    args.state.sync.isSyncingStarredFiles;

  const hasActiveDirection = (
    control: TransferRuntimeControl,
    direction: ActiveTransfer["direction"],
  ) =>
    control.transferState.active.some((item) => item.direction === direction);

  const dispose = (control: TransferRuntimeControl) => {
    if (control.downloadNoticeTimer) clearTimeout(control.downloadNoticeTimer);
    if (control.notificationTimer) clearTimeout(control.notificationTimer);
    control.downloadNoticeTimer = null;
    control.notificationTimer = null;
  };

export type TransferRuntime = ReturnType<typeof createTransferRuntime>;
