import { cachedFileKey, type FileEntry } from "@syncpeer/core/browser";
import { createInitialState, type AppState } from "../app/state.ts";

export type ScreenshotScreen = "devices" | "folders" | "sync";

const REMOTE_ID = "RXB676UZHQX3SONXROHZ7M3DY2VEMB6LCGQCAG5QJ2VIEDX4RIUQ";
const SECOND_ID = "A".repeat(52);
const MODIFIED = Date.UTC(2026, 10, 20, 14, 30);
const stats = (fileCount: number, directoryCount: number, totalBytes: number) => ({
  fileCount, directoryCount, totalBytes,
  symlinkCount: 0, invalidCount: 0, indexReceived: true,
});

const files: FileEntry[] = [
  { name: "2026", path: "2026", type: "directory", size: 0, modifiedMs: MODIFIED,
    stats: stats(42, 3, 420_000_000) },
  { name: "weekend.mov", path: "weekend.mov", type: "file", size: 128_000_000, modifiedMs: MODIFIED },
  { name: "beach.jpg", path: "beach.jpg", type: "file", size: 2_400_000, modifiedMs: MODIFIED },
  { name: "family-photo.jpg", path: "family-photo.jpg", type: "file", size: 3_100_000, modifiedMs: MODIFIED },
  { name: "photo-notes.txt", path: "photo-notes.txt", type: "file", size: 6_400, modifiedMs: MODIFIED },
];

export const createScreenshotState = (screen: ScreenshotScreen): AppState => {
  // Only deterministic, fictional data; never load persisted identities, paths or files.
  const app = createInitialState(null);
  app.connection.deviceName = "My phone";
  app.connection.remoteId = REMOTE_ID;
  app.devices.currentDeviceId = SECOND_ID;
  app.devices.savedDevices = [
    { id: REMOTE_ID, name: "Home workstation", createdAtMs: MODIFIED, isIntroducer: false },
    { id: SECOND_ID.replaceAll("A", "B"), name: "Family laptop",
      createdAtMs: MODIFIED, isIntroducer: false },
  ];
  app.devices.confirmedPeerIds = new Set(app.devices.savedDevices.map(device => device.id));
  app.session.remoteDevice = {
    id: REMOTE_ID, deviceName: "Home workstation", clientName: "Syncpeer", clientVersion: "0.7.0",
  };
  app.session.isConnected = true;
  app.session.lifecyclePhase = "connected";
  app.session.connectionScope = "lan";
  app.session.connectionTransport = "direct-tcp";
  app.session.lastUpdatedAt = "just now";
  app.session.folders = [
    { id: "photos", label: "Family photos", readOnly: false,
      stats: stats(235, 14, 1_800_000_000) },
    { id: "documents", label: "Documents", readOnly: false,
      stats: stats(78, 5, 54_000_000) },
    { id: "private", label: "Private backup", readOnly: false, encrypted: true,
      stats: stats(64, 8, 340_000_000) },
  ];
  app.localFolders = [...app.session.folders];
  app.favorites.items = [
    { key: "folder:photos:", folderId: "photos", path: "", name: "Family photos", kind: "folder" },
  ];
  app.activeTab = screen === "devices" ? "devices" : "folders";
  app.ui.showStabilityNotice = false;
  app.ui.directoryViewMode = "list";

  if (screen === "sync") {
    app.session.currentFolderId = "photos";
    app.session.currentPath = "";
    app.session.entries = files;
    app.session.directory = {
      ...app.session.directory, folderId: "photos",
      entries: files, status: "ready", loadedAtMs: MODIFIED,
    };
    app.favorites.activeDownloads[cachedFileKey("photos", "weekend.mov")] = {
      name: "weekend.mov", text: "Downloading · 68%", progressPercent: 68,
    };
    app.favorites.cachedFileKeys = new Set(["photos:", "photos:beach.jpg", "photos:family-photo.jpg"]);
  }
  return app;
};
