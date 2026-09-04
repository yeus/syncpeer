export type TransferDirection = "download" | "upload";

export interface ActiveTransfer {
  id: string;
  direction: TransferDirection;
  label: string;
  completedBytes: number;
  totalBytes: number;
  cancellable: boolean;
}

export interface TransferNotificationState {
  active: ActiveTransfer[];
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  startedCount: number;
  lastDirection: TransferDirection | null;
  lastLabel: string;
}

export type TransferNotificationEvent =
  | { type: "begin"; transfer: ActiveTransfer }
  | { type: "progress"; id: string; completedBytes: number; totalBytes: number }
  | { type: "finish"; id: string; outcome: "completed" | "failed" | "cancelled" };

export interface TransferNotificationView {
  title: string;
  body: string;
  progress?: number;
  ongoing: boolean;
  cancellable: boolean;
}

export const createTransferNotificationState = (): TransferNotificationState => ({
  active: [],
  completedCount: 0,
  failedCount: 0,
  cancelledCount: 0,
  startedCount: 0,
  lastDirection: null,
  lastLabel: "",
});

const normalizedTransfer = (transfer: ActiveTransfer): ActiveTransfer => ({
  ...transfer,
  completedBytes: Math.max(0, transfer.completedBytes),
  totalBytes: Math.max(0, transfer.totalBytes),
});

export const reduceTransferNotification = (
  state: TransferNotificationState,
  event: TransferNotificationEvent,
): TransferNotificationState => {
  if (event.type === "begin") {
    const idle = state.active.length === 0;
    const transfer = normalizedTransfer(event.transfer);
    return {
      active: [...state.active.filter((item) => item.id !== transfer.id), transfer],
      completedCount: idle ? 0 : state.completedCount,
      failedCount: idle ? 0 : state.failedCount,
      cancelledCount: idle ? 0 : state.cancelledCount,
      startedCount: (idle ? 0 : state.startedCount) + 1,
      lastDirection: transfer.direction,
      lastLabel: transfer.label,
    };
  }
  if (event.type === "progress") {
    return {
      ...state,
      active: state.active.map((item) => item.id === event.id
        ? normalizedTransfer({
            ...item,
            completedBytes: event.completedBytes,
            totalBytes: event.totalBytes,
          })
        : item),
    };
  }
  const finished = state.active.find((item) => item.id === event.id);
  if (!finished) return state;
  return {
    ...state,
    active: state.active.filter((item) => item.id !== event.id),
    completedCount: state.completedCount + Number(event.outcome === "completed"),
    failedCount: state.failedCount + Number(event.outcome === "failed"),
    cancelledCount: state.cancelledCount + Number(event.outcome === "cancelled"),
    lastDirection: finished.direction,
    lastLabel: finished.label,
  };
};

const directionLabel = (direction: TransferDirection) =>
  direction === "download" ? "download" : "upload";

const activeSummary = (active: ActiveTransfer[]) => {
  const downloads = active.filter((item) => item.direction === "download").length;
  const uploads = active.length - downloads;
  return [
    `${active.length} active`,
    downloads > 0 ? `${downloads} ${downloads === 1 ? "download" : "downloads"}` : "",
    uploads > 0 ? `${uploads} ${uploads === 1 ? "upload" : "uploads"}` : "",
  ].filter(Boolean).join(" · ");
};

const aggregateProgress = (active: ActiveTransfer[]) => {
  if (active.some((item) => item.totalBytes <= 0)) return undefined;
  const total = active.reduce((sum, item) => sum + item.totalBytes, 0);
  const completed = active.reduce(
    (sum, item) => sum + Math.min(item.completedBytes, item.totalBytes),
    0,
  );
  return total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : undefined;
};

export const transferNotificationView = (
  state: TransferNotificationState,
): TransferNotificationView | null => {
  if (state.active.length === 1) {
    const transfer = state.active[0];
    const progress = aggregateProgress(state.active);
    return {
      title: `Syncpeer ${directionLabel(transfer.direction)}`,
      body: progress === undefined ? transfer.label : `${transfer.label}: ${progress}%`,
      progress,
      ongoing: true,
      cancellable: transfer.cancellable,
    };
  }
  if (state.active.length > 1) {
    return {
      title: "Syncpeer transfers",
      body: activeSummary(state.active),
      progress: aggregateProgress(state.active),
      ongoing: true,
      cancellable: state.active.every((item) => item.cancellable),
    };
  }
  if (state.cancelledCount > 0) return null;
  if (state.failedCount > 0) {
    return {
      title: "Syncpeer transfer failed",
      body: state.startedCount === 1
        ? state.lastLabel
        : `${state.failedCount} of ${state.startedCount} transfers failed`,
      ongoing: false,
      cancellable: false,
    };
  }
  if (state.completedCount > 0) {
    return {
      title: state.startedCount === 1 && state.lastDirection
        ? `Syncpeer ${directionLabel(state.lastDirection)} complete`
        : "Syncpeer transfers complete",
      body: state.startedCount === 1
        ? state.lastLabel
        : state.completedCount === state.startedCount
          ? `${state.completedCount} transfers completed`
          : `${state.completedCount} of ${state.startedCount} transfers completed`,
      progress: 100,
      ongoing: false,
      cancellable: false,
    };
  }
  return null;
};
