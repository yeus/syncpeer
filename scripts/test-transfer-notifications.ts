import assert from "node:assert/strict";
import test from "node:test";
import {
  createTransferNotificationState,
  reduceTransferNotification,
  transferNotificationView,
} from "../packages/core/dist/ui/transferNotification.js";

const begin = (state: ReturnType<typeof createTransferNotificationState>, overrides: {
  id: string;
  direction?: "download" | "upload";
  label?: string;
  completedBytes?: number;
  totalBytes?: number;
}) => reduceTransferNotification(state, {
  type: "begin",
  transfer: {
    id: overrides.id,
    direction: overrides.direction ?? "download",
    label: overrides.label ?? overrides.id,
    completedBytes: overrides.completedBytes ?? 0,
    totalBytes: overrides.totalBytes ?? 100,
    cancellable: true,
  },
});

test("renders a single transfer with determinate progress", () => {
  const state = reduceTransferNotification(
    begin(createTransferNotificationState(), { id: "one", label: "photo.jpg" }),
    { type: "progress", id: "one", completedBytes: 42, totalBytes: 100 },
  );
  assert.deepEqual(transferNotificationView(state), {
    title: "Syncpeer download",
    body: "photo.jpg: 42%",
    progress: 42,
    ongoing: true,
    cancellable: true,
  });
});

test("summarizes multiple transfers and weights progress by bytes", () => {
  let state = begin(createTransferNotificationState(), {
    id: "download",
    completedBytes: 50,
    totalBytes: 100,
  });
  state = begin(state, {
    id: "upload",
    direction: "upload",
    completedBytes: 0,
    totalBytes: 300,
  });
  assert.deepEqual(transferNotificationView(state), {
    title: "Syncpeer transfers",
    body: "2 active · 1 download · 1 upload",
    progress: 12,
    ongoing: true,
    cancellable: true,
  });
});

test("keeps completion visible and removes a cancelled-only notification", () => {
  const active = begin(createTransferNotificationState(), {
    id: "one",
    direction: "upload",
    label: "report.pdf",
  });
  const complete = reduceTransferNotification(active, {
    type: "finish",
    id: "one",
    outcome: "completed",
  });
  assert.deepEqual(transferNotificationView(complete), {
    title: "Syncpeer upload complete",
    body: "report.pdf",
    progress: 100,
    ongoing: false,
    cancellable: false,
  });
  const cancelled = reduceTransferNotification(active, {
    type: "finish",
    id: "one",
    outcome: "cancelled",
  });
  assert.equal(transferNotificationView(cancelled), null);
});

test("cancelling the remainder of a batch removes its notification", () => {
  let state = begin(createTransferNotificationState(), { id: "one" });
  state = begin(state, { id: "two" });
  state = reduceTransferNotification(state, { type: "finish", id: "one", outcome: "completed" });
  state = reduceTransferNotification(state, { type: "finish", id: "two", outcome: "cancelled" });
  assert.equal(transferNotificationView(state), null);
});

test("shows a combined completion only after every transfer finishes", () => {
  let state = begin(createTransferNotificationState(), { id: "one" });
  state = begin(state, { id: "two", direction: "upload" });
  state = reduceTransferNotification(state, { type: "finish", id: "one", outcome: "completed" });
  assert.equal(transferNotificationView(state)?.ongoing, true);
  state = reduceTransferNotification(state, { type: "finish", id: "two", outcome: "completed" });
  assert.deepEqual(transferNotificationView(state), {
    title: "Syncpeer transfers complete",
    body: "2 transfers completed",
    progress: 100,
    ongoing: false,
    cancellable: false,
  });
});
