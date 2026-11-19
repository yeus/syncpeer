import {
  createSyncpeerSessionStore,
  favoriteKey,
  normalizeDeviceId,
  normalizePath,
  type AppBuildInfo,
  type SyncpeerBrowserClient,
} from "@syncpeer/core/browser";
import {
  canonicalRecordPath,
  joinPimPath,
  normalizePimRoot,
  parseIcsEvent,
  parseVcard,
  sidecarManifestPath,
  sidecarOpPath,
  toIcsEvent,
  toVcard,
} from "../../../core/src/pim/index.ts";
import {
  buildDiagnosticsRegistry,
  runDiagnosticsTests,
  type TaskyonTestFn,
} from "../../../shared/modules/diagnosticsRunner.ts";
import { runFolderContentDiagnostics } from "../lib/folderDiagnostics.ts";
import { connectionDetails, pushSessionLog, type AppState } from "./state.ts";
import { directTcpEndpointForPeer } from "./devicePolicies.ts";

interface DiagnosticsCategory {
  id: string;
  name: string;
  description: string;
}

interface DiagnosticsTestItem {
  id: string;
  name: string;
  description: string;
  categoryId: string;
}

interface DiagnosticsDefinition {
  test: DiagnosticsTestItem;
  fn: TaskyonTestFn;
}

interface DiagnosticsRunOptions {
  expectedAdvertisedDeviceIds?: string[];
  failOnExpectedMissing?: boolean;
  onProgress?: (peerNumber: number, stage: string) => void;
}

const diagnosticsCategories = (): DiagnosticsCategory[] => [
  {
    id: "device",
    name: "Device Health (Read-only)",
    description: "Android battery, system restrictions, service phase and encrypted journal status. No connection or file modifications.",
  },
  {
    id: "network",
    name: "Peer Connectivity (No file writes)",
    description: "Check up to four saved peers with independent TLS and QUIC identity probes. Does not replace the live BEP session or modify files.",
  },
  {
    id: "core",
    name: "Core Connectivity",
    description: "Folder/index diagnostics and upload probe checks.",
  },
  {
    id: "pim",
    name: "PIM",
    description: "Canonical path and basic .vcf/.ics serialization checks.",
  },
  {
    id: "syncthing",
    name: "Syncthing",
    description: "PIM folder favorite/offline pinning and write/read probes.",
  },
  {
    id: "android",
    name: "Android",
    description: "Android provider bridge smoke tests.",
  },
];

const normalizedKnownDeviceIds = (state: AppState): string[] => {
  const localDeviceId = normalizeDeviceId(state.devices.currentDeviceId);
  return state.devices.savedDevices
    .map((device) => normalizeDeviceId(device.id))
    .filter((deviceId) => deviceId !== "" && deviceId !== localDeviceId);
};

const normalizedExpectedDeviceIds = (
  options: DiagnosticsRunOptions | undefined,
): string[] =>
  (options?.expectedAdvertisedDeviceIds ?? [])
    .map((deviceId) => normalizeDeviceId(String(deviceId ?? "")))
    .filter((deviceId) => deviceId !== "");

const createFolderContentTest = (args: {
  state: AppState;
  client: SyncpeerBrowserClient;
  options?: DiagnosticsRunOptions;
}): TaskyonTestFn => {
  const test: TaskyonTestFn = async () => {
    if (!args.state.session.isConnected) {
      throw new Error("No active authenticated peer session. Export Session Logs for connection failures; folder diagnostics must not start a competing connection.");
    }
    const report = await runFolderContentDiagnostics({
      client: args.client,
      options: connectionDetails(args.state),
      knownDeviceIds: normalizedKnownDeviceIds(args.state),
      expectedDeviceIds: normalizedExpectedDeviceIds(args.options),
      maxPollAttempts: 16,
      pollIntervalMs: 250,
    });
    if (
      args.options?.failOnExpectedMissing &&
      report.advertisedDevices.missingExpectedDeviceIds.length > 0
    ) {
      throw new Error(
        `Expected advertised device IDs missing: ${report.advertisedDevices.missingExpectedDeviceIds.join(", ")}`,
      );
    }
    return report;
  };
  test.description = "End-to-end folder/index/readDir diagnostics";
  test.timeoutMs = 90_000;
  return test;
};

const writableProbeFolder = (
  folders: ReturnType<ReturnType<typeof createSyncpeerSessionStore>["getState"]>["folders"],
) =>
  folders.find(
    (folder) =>
      !folder.encrypted &&
      !folder.readOnly &&
      !folder.needsPassword &&
      Number(folder.stopReason ?? 0) === 0 &&
      folder.localDevicePresentInFolder !== false,
  );

const runUploadProbe = async (args: {
  state: AppState;
  client: SyncpeerBrowserClient;
}) => {
  if (!args.state.session.isConnected) {
    return { skipped: true, reason: "No active authenticated peer session; upload probe did not initiate a connection." };
  }
  const session = createSyncpeerSessionStore({ transport: args.client });
  await session.actions.connect(connectionDetails(args.state));
  const folder = writableProbeFolder(session.getState().folders);
  if (!folder) {
    return {
      skipped: true,
      reason: "No writable non-encrypted folder available for upload probe.",
    };
  }
  await session.actions.openFolder(folder.id, connectionDetails(args.state));
  const current = session.getState();
  if (!current.remoteFs?.writeFileFully) {
    throw new Error("Session transport does not expose writeFileFully.");
  }
  const payload = `hello_from_syncpeer ${new Date().toISOString()}\n`;
  const targetPath = normalizePath(
    [current.currentPath, "hello_from_syncpeer.txt"].filter(Boolean).join("/"),
  );
  await current.remoteFs.writeFileFully(
    folder.id,
    targetPath,
    new TextEncoder().encode(payload),
    { modifiedMs: Date.now() },
  );
  await session.actions.reloadCurrentDirectory(connectionDetails(args.state));
  const listed = session.getState().entries.some((entry) => entry.path === targetPath);
  return {
    skipped: false,
    folderId: folder.id,
    targetPath,
    listedAfterUpload: listed,
    payloadBytes: payload.length,
  };
};

const pimPathDefinition = (): DiagnosticsDefinition => ({
  test: {
    id: "pim.canonical_paths",
    name: "PIM Canonical Paths",
    description: "Verifies one-entry-per-file .vcf/.ics and sidecar path layout.",
    categoryId: "pim",
  },
  fn: async () => ({
    contactPath: canonicalRecordPath({
      domain: "contacts",
      collectionId: "default",
      recordId: "alice",
    }),
    eventPath: canonicalRecordPath({
      domain: "calendar",
      collectionId: "default",
      recordId: "event-1",
    }),
    manifest: sidecarManifestPath("contacts", "default"),
    opPath: sidecarOpPath({
      domain: "calendar",
      collectionId: "default",
      epoch: "2026-05",
      opId: "devA-1",
    }),
  }),
});

const vcardRoundTripDefinition = (): DiagnosticsDefinition => ({
  test: {
    id: "pim.vcf_roundtrip",
    name: "PIM VCF Roundtrip",
    description: "Serializes and parses contact payload fields.",
    categoryId: "pim",
  },
  fn: async () => ({
    parsed: parseVcard(
      toVcard({
        uid: "test-contact",
        displayName: "Alice Example",
        phones: ["+1-555-1234"],
        emails: ["alice@example.com"],
      }),
    ),
  }),
});

const icsRoundTripDefinition = (): DiagnosticsDefinition => ({
  test: {
    id: "pim.ics_roundtrip",
    name: "PIM ICS Roundtrip",
    description: "Serializes and parses basic event payload fields.",
    categoryId: "pim",
  },
  fn: async () => ({
    parsed: parseIcsEvent(
        toIcsEvent({
          uid: "test-event",
          title: "Example Meeting",
          startMs: Date.UTC(2026, 0, 1, 9),
          endMs: Date.UTC(2026, 0, 1, 10),
          stampMs: Date.UTC(2026, 0, 1, 8),
        }),
    ),
  }),
});

const pimDefinitions = (): DiagnosticsDefinition[] => [
  pimPathDefinition(),
  vcardRoundTripDefinition(),
  icsRoundTripDefinition(),
];

const pimFavoriteDefinition = (args: {
  state: AppState;
  client: SyncpeerBrowserClient;
}): DiagnosticsDefinition => ({
  test: {
    id: "syncthing.pim_favorite_cached",
    name: "PIM Favorite + Cache Status",
    description: "Checks whether PIM root is favorited and cached offline.",
    categoryId: "syncthing",
  },
  fn: async () => {
    const folderId = args.state.session.currentFolderId;
    if (!args.state.session.isConnected || !folderId) {
      return { skipped: true, reason: "Connect and open a folder first." };
    }
    const root = normalizePimRoot(args.state.pim.syncFolderPath);
    const pimTreeRoot = `${root}/syncpeer/pim`;
    const key = favoriteKey(folderId, normalizePath(pimTreeRoot), "folder");
    const favorited = args.state.favorites.items.some((item) => item.key === key);
    const statuses = await args.client.getCachedStatuses(folderId, [pimTreeRoot]);
    return { favorited, statuses };
  },
});

const pimWriteReadDefinition = (state: AppState): DiagnosticsDefinition => ({
  test: {
    id: "syncthing.pim_write_read_probe",
    name: "PIM Write/Read Probe",
    description: "Writes a probe vCard file and reads it back.",
    categoryId: "syncthing",
  },
  fn: async () => {
    const folderId = state.session.currentFolderId;
    const remoteFs = state.session.remoteFs;
    if (!state.session.isConnected || !folderId || !remoteFs?.writeFileFully) {
      return { skipped: true, reason: "Writable connected folder required." };
    }
    const probePath = joinPimPath(
      normalizePimRoot(state.pim.syncFolderPath),
      "syncpeer/pim/contacts/collections/default/entries/probe-contact.vcf",
    );
    const payload = toVcard({
      uid: "probe-contact",
      displayName: "Probe Contact",
      phones: ["+1-555-0000"],
      emails: ["probe@example.com"],
    });
    await remoteFs.writeFileFully(folderId, probePath, new TextEncoder().encode(payload), {
      modifiedMs: Date.now(),
    });
    const readBack = new TextDecoder().decode(
      await remoteFs.readFileFully(folderId, probePath),
    );
    return { probePath, parsed: parseVcard(readBack) };
  },
});

const syncthingDefinitions = (args: {
  state: AppState;
  client: SyncpeerBrowserClient;
}): DiagnosticsDefinition[] => [
  pimFavoriteDefinition(args),
  pimWriteReadDefinition(args.state),
];

const androidContactsDefinition = (
  client: SyncpeerBrowserClient,
): DiagnosticsDefinition => ({
  test: {
    id: "android.contacts_list_smoke",
    name: "Android Contacts List Smoke",
    description: "Calls Android contacts provider bridge list endpoint.",
    categoryId: "android",
  },
  fn: async () => {
    try {
      return { supported: true, count: (await client.listAndroidContacts()).length };
    } catch (error) {
      return {
        supported: false,
        skipped: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

const androidCalendarDefinition = (
  client: SyncpeerBrowserClient,
): DiagnosticsDefinition => ({
  test: {
    id: "android.calendar_list_smoke",
    name: "Android Calendar List Smoke",
    description: "Calls Android calendar provider bridge list endpoint.",
    categoryId: "android",
  },
  fn: async () => {
    try {
      return {
        supported: true,
        count: (await client.listAndroidCalendarEvents({})).length,
      };
    } catch (error) {
      return {
        supported: false,
        skipped: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

const androidTransferDefinition = (args: {
  client: SyncpeerBrowserClient;
  appInfo: AppBuildInfo;
}): DiagnosticsDefinition => ({
  test: {
    id: "android.transfer_runtime_command",
    name: "Android Transfer Runtime Command",
    description: "Starts and stops the Android UIDT or legacy transfer runtime.",
    categoryId: "android",
  },
  fn: async () => {
    if (args.appInfo.runtimeSurface !== "android-ui") {
      return { skipped: true, reason: "Android UI runtime required." };
    }
    if (!args.client.startTransfer || !args.client.stopTransfer) {
      return { skipped: true, reason: "Transfer service bridge is unavailable." };
    }
    await args.client.startTransfer("Diagnostics transfer");
    try {
      return { supported: true, started: true };
    } finally {
      await args.client.stopTransfer();
    }
  },
});

const androidDefinitions = (args: {
  client: SyncpeerBrowserClient;
  appInfo: AppBuildInfo;
}): DiagnosticsDefinition[] => [
  androidContactsDefinition(args.client),
  androidCalendarDefinition(args.client),
  androidTransferDefinition(args),
];

type DeviceDiagnosticDeps = {
  client: SyncpeerBrowserClient;
  state: AppState;
  appInfo: AppBuildInfo;
  readDeviceHealth?: () => Promise<unknown>;
  readDiagnosticJournal?: () => Promise<{ writeInitialized: boolean; runCount: number; queued: number }>;
};

const deviceDefinitions = (args: DeviceDiagnosticDeps): DiagnosticsDefinition[] => [
  {
    test: {
      id: "device.health_snapshot",
      name: "Phone Health and Session State",
      description: "Read-only snapshot of battery, restrictions and UI session lifecycle.",
      categoryId: "device",
    },
    fn: async () => {
      if (args.appInfo.runtimeSurface !== "android-ui" || !args.readDeviceHealth)
        return { skipped: true, reason: "Requires an Android device." };
      return {
        android: await args.readDeviceHealth(),
        sessionPhase: args.state.session.lifecyclePhase,
        connected: args.state.session.isConnected,
        uiVisible: args.state.ui.isAppVisible,
      };
    },
  },
  {
    test: {
      id: "device.journal_readability",
      name: "Crash Journal Read and Write Status",
      description: "Checks that the native journal initialized and can list encrypted runs.",
      categoryId: "device",
    },
    fn: async () => {
      if (args.appInfo.runtimeSurface !== "android-ui" || !args.readDiagnosticJournal)
        return { skipped: true, reason: "Requires Android diagnostic journal." };
      const status = await args.readDiagnosticJournal();
      if (!status.writeInitialized)
        throw new Error("Encrypted crash journal has not acknowledged write initialization.");
      return status;
    },
  },
  {
    test: {
      id: "device.transfer_job_status",
      name: "Native Transfer Queue Status",
      description: "Read-only job status, retry state and failure categories; never exports file paths or identities.",
      categoryId: "device",
    },
    fn: async () => {
      if (args.appInfo.runtimeSurface !== "android-ui" || !args.client.listServiceTransferJobs)
        return { skipped: true, reason: "Requires Android native transfer service." };
      const jobs = await args.client.listServiceTransferJobs();
      const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
      for (const job of jobs) counts[job.phase] += 1;
      const safeReason = (reason: string | undefined) =>
        reason && ["network", "storage", "cancelled", "unavailable", "other"].includes(reason)
          ? reason : "other";
      return {
        total: jobs.length,
        phases: counts,
        latest: jobs.slice(-32).map(job => ({
          direction: job.direction,
          phase: job.phase,
          reason: job.phase === "failed" ? safeReason(job.reason) : null,
          attempts: job.attempts ?? 0,
          transferredBytes: job.transferredBytes,
          totalBytes: job.totalBytes,
          updatedAtMs: job.updatedAtMs,
          nextAttemptMs: job.nextAttemptMs ?? null,
        })),
      };
    },
  },
];

const containsFailedNestedDiagnostics = (value: unknown): boolean =>
  value !== null && typeof value === "object" &&
  "summary" in value &&
  value.summary !== null && typeof value.summary === "object" &&
  "allPassed" in value.summary && value.summary.allPassed === false;

const executeDefinitions = async (definitions: DiagnosticsDefinition[]) => {
  const tests: Record<string, TaskyonTestFn> = {};
  for (const definition of definitions) {
    tests[definition.test.name] = definition.fn;
  }
  const results = (await runDiagnosticsTests(tests, { details: true })).map(result =>
    result.ok && containsFailedNestedDiagnostics(result.details)
      ? { ...result, ok: false } : result);
  const passed = results.filter((item) => item.ok).length;
  return { results, passed, failed: results.length - passed };
};

export const createDiagnosticsActions = (args: {
  state: AppState;
  client: SyncpeerBrowserClient;
  appInfo: AppBuildInfo;
  readDeviceHealth?: () => Promise<unknown>;
  readDiagnosticJournal?: () => Promise<{ writeInitialized: boolean; runCount: number; queued: number }>;
}) => {
  const runFolderDiagnosticsTest = async (options?: DiagnosticsRunOptions) => {
    const registry = buildDiagnosticsRegistry({
      builtins: [
        {
          testName: "folderContentDiagnostics",
          func: createFolderContentTest({ ...args, options }),
          sourcePath: "packages/app/src/lib/folderDiagnostics.ts",
        },
        {
          testName: "uploadProbeDiagnostics",
          func: Object.assign(() => runUploadProbe(args), {
            description: "Upload probe (hello_from_syncpeer.txt)",
            timeoutMs: 60_000,
          }),
          sourcePath: "packages/app/src/lib/folderDiagnostics.ts",
        },
      ],
      modules: [],
    });
    const results = await runDiagnosticsTests(registry.tests, {
      details: true,
      timeoutMs: 90_000,
    });
    const passed = results.filter((result) => result.ok).length;
    return {
      buildInfo: args.appInfo,
      summary: {
        runAtIso: new Date().toISOString(),
        allPassed: passed === results.length,
        passed,
        failed: results.length - passed,
      },
      results,
    };
  };

  const definitions = (options?: DiagnosticsRunOptions): DiagnosticsDefinition[] => [
    ...deviceDefinitions(args),
    {
      test: {
        id: "network.saved_peer_paths",
        name: "Diagnose Saved Peer Connections",
        description: "Checks saved peers using isolated local/global discovery, TCP/TLS and QUIC identity handshakes. No BEP or file writes.",
        categoryId: "network",
      },
      fn: Object.assign(async () => {
        const selected = normalizeDeviceId(args.state.devices.selectedSavedDeviceId);
        const activePeerId = normalizeDeviceId(
          args.state.session.remoteDevice?.id || args.state.session.activeConnectDeviceId);
        const targets = args.state.devices.savedDevices
          .filter(peer => normalizeDeviceId(peer.id) !== normalizeDeviceId(args.state.devices.currentDeviceId))
          .slice().sort((a, b) =>
            Number(normalizeDeviceId(b.id) === selected) - Number(normalizeDeviceId(a.id) === selected))
          .map(peer => ({
            deviceId: normalizeDeviceId(peer.id),
            knownTcp: directTcpEndpointForPeer(args.state, peer.id) ?? undefined,
            activeSession: args.state.session.isConnected &&
              normalizeDeviceId(peer.id) === activePeerId,
          }));
        if (!targets.length) return { skipped: true, reason: "No saved peers configured." };
        pushSessionLog(args.state, "info", "diagnostics.peer_probe.started",
          "Testing saved peer connection paths without modifying the active session.",
          { savedPeerCount: targets.length });
        const report = await args.client.probeSavedPeerConnectivity(
          targets, args.state.connection.discoveryServer,
          (peerNumber, stage) => {
            options?.onProgress?.(peerNumber, stage);
            pushSessionLog(args.state, "info", "diagnostics.peer_probe.stage",
              "Connectivity probe running.", { peerNumber, stage });
          },
        );
        const passed = report.peers.filter(peer =>
          peer.activeSessionPreserved ||
          peer.attempts.some(attempt => attempt.outcome === "verified")).length;
        const intermittent = report.peers.filter(peer => peer.intermittentDirectTcp).length;
        pushSessionLog(args.state, "info", "diagnostics.peer_probe.completed",
          "Saved peer connection-path checks finished.",
          { testedPeers: report.testedPeerCount, verifiedPeers: passed, intermittentPeers: intermittent });
        return { ...report, liveSession: {
          connected: args.state.session.isConnected,
          phase: args.state.session.lifecyclePhase,
          transport: args.state.session.connectionTransport || "none",
          scope: args.state.session.connectionScope || "unknown",
        }, summary: { passed, failed: report.testedPeerCount - passed,
          intermittentPeers: intermittent,
          allPassed: passed === report.testedPeerCount && intermittent === 0 && !report.truncated } };
      }, { timeoutMs: 180_000, description: "Isolated peer transport/TLS checks (no BEP or file writes)" }),
    },
    {
      test: {
        id: "core.folder_diagnostics",
        name: "Folder Diagnostics",
        description: "Runs folder/index diagnostics plus upload probe.",
        categoryId: "core",
      },
      fn: async () => runFolderDiagnosticsTest(options),
    },
    ...pimDefinitions(),
    ...syncthingDefinitions(args),
    ...androidDefinitions(args),
  ];

  const loadDiagnosticsCatalog = async () => ({
    categories: diagnosticsCategories(),
    tests: definitions().map((item) => item.test),
  });

  const runDiagnosticsTestById = async (
    testId: string,
    options?: DiagnosticsRunOptions,
  ) => {
    const definition = definitions(options).find((item) => item.test.id === testId);
    if (!definition) throw new Error(`Unknown diagnostics test: ${testId}`);
    const execution = await executeDefinitions([definition]);
    return {
      buildInfo: args.appInfo,
      summary: {
        runAtIso: new Date().toISOString(),
        mode: "single" as const,
        testId,
        allPassed: execution.passed === execution.results.length,
        passed: execution.passed,
        failed: execution.failed,
      },
      results: execution.results,
    };
  };

  const runDiagnosticsCategory = async (
    categoryId: string,
    options?: DiagnosticsRunOptions,
  ) => {
    const selected = definitions(options).filter(
      (item) => item.test.categoryId === categoryId,
    );
    if (selected.length === 0) {
      throw new Error(`No diagnostics tests found for category: ${categoryId}`);
    }
    const execution = await executeDefinitions(selected);
    return {
      buildInfo: args.appInfo,
      summary: {
        runAtIso: new Date().toISOString(),
        mode: "category" as const,
        categoryId,
        allPassed: execution.passed === execution.results.length,
        passed: execution.passed,
        failed: execution.failed,
      },
      results: execution.results,
    };
  };

  const runAllDiagnostics = async (options?: DiagnosticsRunOptions) => {
    const execution = await executeDefinitions(definitions(options));
    return {
      buildInfo: args.appInfo,
      summary: {
        runAtIso: new Date().toISOString(),
        mode: "all" as const,
        allPassed: execution.passed === execution.results.length,
        passed: execution.passed,
        failed: execution.failed,
      },
      results: execution.results,
    };
  };

  return {
    loadDiagnosticsCatalog,
    runDiagnosticsTestById,
    runDiagnosticsCategory,
    runAllDiagnostics,
  };
};
