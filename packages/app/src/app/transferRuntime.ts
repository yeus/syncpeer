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

export const createTransferRuntime = (args: {
  state: AppState;
  client: SyncpeerBrowserClient;
  runtimeSurface: "cli" | "desktop-ui" | "android-ui" | "web-ui";
}) => {
  let downloadNoticeTimer: number | null = null;
  let lastNotificationAtMs = 0;
  let permissionRequested = false;
  let notificationSetup: Promise<void> | null = null;
  let notificationTimer: ReturnType<typeof setTimeout> | null = null;
  let notificationInFlight: Promise<void> | null = null;
  let pendingNotification: PendingNotification | null = null;
  let transferState = createTransferNotificationState();
  const cancellations = new Map<
    string,
    { direction: ActiveTransfer["direction"]; cancel: () => void }
  >();
  let runtimeStarted = false;
  let runtimeTransition = Promise.resolve();

  const cancelAll = () => {
    for (const transfer of cancellations.values()) transfer.cancel();
  };

  const ensurePermission = async () => {
    try {
      if (await isNativeNotificationPermissionGranted()) return true;
      if (permissionRequested) return false;
      permissionRequested = true;
      return (await requestNativeNotificationPermission()) === "granted";
    } catch {
      return false;
    }
  };

  const ensureNotificationSetup = () => {
    if (!supportsOngoingTransferNotifications(args.runtimeSurface)) {
      return Promise.resolve();
    }
    if (!notificationSetup) {
      notificationSetup = (async () => {
        if (args.client.updateTransferNotification) {
          await addPluginListener<{ actionId?: string; notification?: { id?: number } }>(
            "syncpeer-android",
            "transferAction",
            (event) => {
              if (
                event.actionId === CANCEL_ACTION &&
                Number(event.notification?.id) === NOTIFICATION_ID
              ) {
                cancelAll();
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
            cancelAll();
          }
        });
      })().catch(() => undefined);
    }
    return notificationSetup;
  };

  const flushNotification = async () => {
    if (notificationInFlight || !pendingNotification) return;
    const next = pendingNotification;
    pendingNotification = null;
    notificationInFlight = (async () => {
      await ensureNotificationSetup();
      if (!(await ensurePermission())) return;
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
        lastNotificationAtMs = Date.now();
      } catch {
        // Notifications are best-effort.
      }
    })().finally(() => {
      notificationInFlight = null;
      if (!pendingNotification) return;
      const elapsed = Date.now() - lastNotificationAtMs;
      if (pendingNotification.force || elapsed >= UPDATE_INTERVAL_MS) {
        void flushNotification();
      } else if (!notificationTimer) {
        notificationTimer = setTimeout(() => {
          notificationTimer = null;
          void flushNotification();
        }, UPDATE_INTERVAL_MS - elapsed);
      }
    });
    await notificationInFlight;
  };

  const showNotification = async (
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
    pendingNotification = {
      id: NOTIFICATION_ID,
      title,
      body,
      ongoing: options?.ongoing ?? true,
      force: options?.force ?? false,
      progressPercent: options?.progressPercent,
      cancellable: options?.cancellable ?? false,
    };
    const elapsed = Date.now() - lastNotificationAtMs;
    if (
      options?.force ||
      (!notificationInFlight && elapsed >= UPDATE_INTERVAL_MS)
    ) {
      await flushNotification();
      return;
    }
    if (!notificationTimer) {
      notificationTimer = setTimeout(() => {
        notificationTimer = null;
        void flushNotification();
      }, Math.max(0, UPDATE_INTERVAL_MS - elapsed));
    }
  };

  const clearNotification = async () => {
    if (!supportsOngoingTransferNotifications(args.runtimeSurface)) return;
    pendingNotification = null;
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = null;
    if (notificationInFlight) await notificationInFlight.catch(() => undefined);
    if (transferState.active.length > 0) return;
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

  const reconcileRuntime = () => {
    runtimeTransition = runtimeTransition
      .catch(() => undefined)
      .then(async () => {
        const shouldRun = transferState.active.length > 0;
        if (shouldRun === runtimeStarted) return;
        runtimeStarted = shouldRun;
        try {
          if (shouldRun) {
            await args.client.startTransfer?.(
              transferState.active.length === 1
                ? transferState.active[0].label
                : `${transferState.active.length} transfers`,
            );
          } else {
            await args.client.stopTransfer?.();
          }
        } catch (error) {
          runtimeStarted = false;
          reportActionError(
            args.state,
            shouldRun
              ? "transfer_runtime.start_failed"
              : "transfer_runtime.stop_failed",
            error,
          );
        }
      });
    return runtimeTransition;
  };

  const renderNotification = async (force = false) => {
    const view = transferNotificationView(transferState);
    if (!view) {
      await clearNotification();
      return;
    }
    await showNotification(view.title, view.body, {
      ongoing: view.ongoing,
      force,
      progress: view.ongoing,
      progressPercent: view.progress,
      cancellable: view.cancellable,
    });
  };

  const begin = async (transfer: ActiveTransfer, cancel: () => void) => {
    transferState = reduceTransferNotification(transferState, {
      type: "begin",
      transfer,
    });
    cancellations.set(transfer.id, { direction: transfer.direction, cancel });
    await reconcileRuntime();
    await renderNotification(true);
  };

  const update = (id: string, completedBytes: number, totalBytes: number) => {
    transferState = reduceTransferNotification(transferState, {
      type: "progress",
      id,
      completedBytes,
      totalBytes,
    });
    void renderNotification();
  };

  const finish = async (
    id: string,
    outcome: "completed" | "failed" | "cancelled",
  ) => {
    cancellations.delete(id);
    transferState = reduceTransferNotification(transferState, {
      type: "finish",
      id,
      outcome,
    });
    await reconcileRuntime();
    await renderNotification(true);
  };

  const setDownloadNotice = (message: string, clearAfterMs = 0) => {
    args.state.ui.downloadNotice = message;
    if (downloadNoticeTimer) clearTimeout(downloadNoticeTimer);
    downloadNoticeTimer = null;
    if (clearAfterMs > 0 && typeof window !== "undefined") {
      downloadNoticeTimer = window.setTimeout(() => {
        args.state.ui.downloadNotice = "";
        downloadNoticeTimer = null;
      }, clearAfterMs);
    }
  };

  const setActiveDownload = (
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

  const clearActiveDownload = (key: string) => {
    const remaining = { ...args.state.favorites.activeDownloads };
    delete remaining[key];
    args.state.favorites.activeDownloads = remaining;
    args.state.favorites.isDownloading = Object.keys(remaining).length > 0;
  };

  const cancelDownload = (folderId?: string, path?: string) => {
    if (!args.state.favorites.isDownloading) return;
    if (folderId !== undefined && path !== undefined) {
      cancellations.get(`download:${cachedFileKey(folderId, path)}`)?.cancel();
      return;
    }
    for (const transfer of cancellations.values()) {
      if (transfer.direction === "download") transfer.cancel();
    }
  };

  const transferInProgress = () =>
    Object.keys(args.state.favorites.activeDownloads).length > 0 ||
    args.state.ui.uploadProgressActive ||
    args.state.sync.isSyncingStarredFiles;

  const hasActiveDirection = (direction: ActiveTransfer["direction"]) =>
    transferState.active.some((item) => item.direction === direction);

  const dispose = () => {
    if (downloadNoticeTimer) clearTimeout(downloadNoticeTimer);
    if (notificationTimer) clearTimeout(notificationTimer);
    downloadNoticeTimer = null;
    notificationTimer = null;
  };

  return {
    begin,
    update,
    finish,
    setDownloadNotice,
    setActiveDownload,
    clearActiveDownload,
    cancelDownload,
    cancelAll,
    transferInProgress,
    hasActiveDirection,
    dispose,
  };
};

export type TransferRuntime = ReturnType<typeof createTransferRuntime>;
