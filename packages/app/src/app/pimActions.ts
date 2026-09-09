import {
  favoriteKey,
  normalizePath,
  type FileEntry,
  type SyncpeerBrowserClient,
  type SyncpeerSessionStore,
} from "@syncpeer/core/browser";
import {
  createPimBootstrapPlan,
  joinPimPath,
  normalizePimRoot,
  parseIcsEvent,
  parseVcard,
  splitIcsEvents,
  splitVcards,
  toIcsEvent,
  toVcard,
} from "../../../core/src/pim/index.ts";
import { reportActionError } from "./actionErrors.ts";
import { refreshFolderRootCachedStatuses } from "./cacheStatusActions.ts";
import { updateCachedKey } from "./downloadPolicies.ts";
import { connectionDetails, type AppState } from "./state.ts";

const readDirectoryEntriesRecursively = async (
  remoteFs: NonNullable<AppState["session"]["remoteFs"]>,
  folderId: string,
  dirPath: string,
  depthLeft: number,
): Promise<FileEntry[]> => {
  if (depthLeft < 0) return [];
  const entries = await remoteFs.readDir(folderId, dirPath);
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.type === "directory")
      .map((entry) => readDirectoryEntriesRecursively(remoteFs, folderId, entry.path, depthLeft - 1)),
  );
  return [...entries, ...nested.flat()];
};

const ensurePimFolderFavorite = async (
  state: AppState,
  client: SyncpeerBrowserClient,
  folderId: string,
  pimRoot: string,
) => {
  const path = normalizePath(pimRoot);
  const key = favoriteKey(folderId, path, "folder");
  const exists = state.favorites.items.some((item) => item.key === key);
  if (!exists) {
    const next = await client.upsertFavorite({
      key,
      folderId,
      path,
      name: "PIM (Contacts & Calendar)",
      kind: "folder",
    });
    state.favorites.items = next;
  }
};

const cachePimTreeOffline = async (
  state: AppState,
  client: SyncpeerBrowserClient,
  folderId: string,
  remoteFs: NonNullable<AppState["session"]["remoteFs"]>,
  pimRoot: string,
) => {
  const entries = await readDirectoryEntriesRecursively(remoteFs, folderId, pimRoot, 8);
  const files = entries.filter((entry) => entry.type === "file");
  for (const entry of files) {
    const bytes = await remoteFs.readFileFully(folderId, entry.path);
    const name = entry.path.split("/").pop() ?? "file";
    await client.cacheFile(folderId, entry.path, name, bytes, entry.modifiedMs);
    updateCachedKey(state, folderId, entry.path, true);
  }
  await refreshFolderRootCachedStatuses(state, client, [folderId]);
};

interface PimActionDependencies {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
}

export const pickAndroidPimDirectory = async (args: PimActionDependencies) => {
  const { state, client } = args;
  try {
    const treeUri = await client.pickAndroidSafDirectory();
    await client.setAndroidSafTreeUri(treeUri);
    state.pim.syncFolderMode = "choose";
    state.pim.syncFolderPath = treeUri;
    state.devices.identityNotice = "Android PIM directory selected.";
  } catch (error) {
    reportActionError(state, "pim.android.pick_directory.failed", error);
  }
};

export const initializePimFolder = async (args: PimActionDependencies) => {
  const { state, client, sessionStore } = args;
  if (!state.pim.enabled) {
    state.ui.uploadMessage = "Enable Contacts + Calendar Sync first.";
    return;
  }
  if (!state.session.isConnected || !state.session.remoteFs) {
    state.ui.uploadMessage = "Connect first to initialize PIM structure.";
    return;
  }
  const folderId = state.session.currentFolderId;
  if (!folderId) {
    state.ui.uploadMessage = "Open a folder first, then initialize PIM structure.";
    return;
  }
  if (!state.session.remoteFs.writeFileFully) {
    state.ui.uploadMessage = "Current connection does not support writing files.";
    return;
  }
  try {
    const root = normalizePimRoot(state.pim.syncFolderPath);
    const encoder = new TextEncoder();
    const writes = createPimBootstrapPlan(root, Date.now());
    for (const write of writes) {
      await state.session.remoteFs.writeFileFully(
        folderId,
        write.path,
        encoder.encode(write.contents),
        { modifiedMs: write.modifiedMs },
      );
    }
    const pimTreeRoot = `${root}/syncpeer/pim`;
    await ensurePimFolderFavorite(state, client, folderId, pimTreeRoot);
    await cachePimTreeOffline(state, client, folderId, state.session.remoteFs, pimTreeRoot);
    state.ui.uploadMessage = "Initialized contacts/calendar structure in current folder.";
    await sessionStore.actions.reloadCurrentDirectory(connectionDetails(state));
  } catch (error) {
    reportActionError(state, "pim.initialize_folder.failed", error, {
      folderId: state.session.currentFolderId,
    });
  }
};

export const syncAndroidPimNow = async (args: PimActionDependencies) => {
  const { state, client, sessionStore } = args;
  if (!state.pim.enabled) {
    state.ui.uploadMessage = "Enable Contacts + Calendar Sync first.";
    return;
  }
  if (!state.session.isConnected || !state.session.remoteFs || !state.session.currentFolderId) {
    state.ui.uploadMessage = "Connect and open a folder first.";
    return;
  }
  if (!state.session.remoteFs.writeFileFully) {
    state.ui.uploadMessage = "Current connection does not support writing files.";
    return;
  }
  const folderId = state.session.currentFolderId;
  const remoteFs = state.session.remoteFs;
  const root = normalizePimRoot(state.pim.syncFolderPath);
  const contactsEntriesDir = `${root}/syncpeer/pim/contacts/collections/default/entries`;
  const calendarEntriesDir = `${root}/syncpeer/pim/calendar/collections/default/entries`;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  try {
    let writtenContacts = 0;
    let writtenEvents = 0;
    let importedContacts = 0;
    let importedEvents = 0;

    if (state.pim.contactsEnabled && state.pim.androidContactsIntegration) {
      const androidContacts = await client.listAndroidContacts();
      for (const contact of androidContacts) {
        const filePath = joinPimPath(
          contactsEntriesDir,
          `android-${contact.contactId}.vcf`,
        );
        const payload = toVcard({
          uid: `android-${contact.contactId}`,
          displayName: contact.displayName,
          phones: contact.phones ?? [],
          emails: contact.emails ?? [],
        });
        await remoteFs.writeFileFully(folderId, filePath, encoder.encode(payload), { modifiedMs: Date.now() });
        writtenContacts += 1;
      }

      const entries = await readDirectoryEntriesRecursively(remoteFs, folderId, contactsEntriesDir, 3);
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.path.endsWith(".vcf")) continue;
        const name = entry.path.split("/").pop() ?? "";
        if (!name.startsWith("android-")) continue;
        const contactId = name.replace(/^android-/, "").replace(/\.vcf$/i, "");
        if (!contactId.trim()) continue;
        const bytes = await remoteFs.readFileFully(folderId, entry.path);
        const parsed = parseVcard(decoder.decode(bytes));
        if (!parsed.displayName) continue;
        await client.upsertAndroidContact({
          contactId,
          displayName: parsed.displayName,
          phones: parsed.phones,
          emails: parsed.emails,
        });
        importedContacts += 1;
      }
    }

    if (state.pim.calendarEnabled && state.pim.androidCalendarIntegration) {
      const androidEvents = await client.listAndroidCalendarEvents({});
      for (const event of androidEvents) {
        const filePath = joinPimPath(
          calendarEntriesDir,
          `android-${event.eventId}.ics`,
        );
        const payload = toIcsEvent({
          uid: `android-${event.eventId}`,
          title: event.title,
          startMs: event.startMs,
          endMs: event.endMs,
          stampMs: Date.now(),
        });
        await remoteFs.writeFileFully(folderId, filePath, encoder.encode(payload), { modifiedMs: Date.now() });
        writtenEvents += 1;
      }

      const entries = await readDirectoryEntriesRecursively(remoteFs, folderId, calendarEntriesDir, 3);
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.path.endsWith(".ics")) continue;
        const name = entry.path.split("/").pop() ?? "";
        if (!name.startsWith("android-")) continue;
        const eventId = name.replace(/^android-/, "").replace(/\.ics$/i, "");
        if (!eventId.trim()) continue;
        const bytes = await remoteFs.readFileFully(folderId, entry.path);
        const parsed = parseIcsEvent(decoder.decode(bytes));
        if (!parsed.title || parsed.startMs <= 0 || parsed.endMs <= 0) continue;
        await client.upsertAndroidCalendarEvent({
          eventId,
          title: parsed.title,
          startMs: parsed.startMs,
          endMs: parsed.endMs,
          allDay: false,
        });
        importedEvents += 1;
      }
    }

    const pimTreeRoot = `${root}/syncpeer/pim`;
    await ensurePimFolderFavorite(state, client, folderId, pimTreeRoot);
    await cachePimTreeOffline(state, client, folderId, remoteFs, pimTreeRoot);

    state.ui.uploadMessage =
      `PIM sync complete. Wrote ${writtenContacts} contacts + ${writtenEvents} events; imported ${importedContacts} contacts + ${importedEvents} events.`;
    await sessionStore.actions.reloadCurrentDirectory(connectionDetails(state));
  } catch (error) {
    reportActionError(state, "pim.android.sync_now.failed", error, {
      folderId: state.session.currentFolderId,
    });
  }
};

export const importProviderPimFromSyncthingFolder = async (args: PimActionDependencies) => {
  const { state, client } = args;
  if (!state.pim.enabled) {
    state.ui.uploadMessage = "Enable Contacts + Calendar Sync first.";
    return;
  }
  if (!state.session.isConnected || !state.session.remoteFs || !state.session.currentFolderId) {
    state.ui.uploadMessage = "Connect and open a folder first.";
    return;
  }
  const folderId = state.session.currentFolderId;
  const remoteFs = state.session.remoteFs;
  const root = normalizePimRoot(state.pim.syncFolderPath);
  const contactsEntriesDir = `${root}/syncpeer/pim/contacts/collections/default/entries`;
  const calendarEntriesDir = `${root}/syncpeer/pim/calendar/collections/default/entries`;
  const decoder = new TextDecoder();
  try {
    let importedContacts = 0;
    let importedEvents = 0;

    if (state.pim.contactsEnabled && state.pim.androidContactsIntegration) {
      const entries = await readDirectoryEntriesRecursively(remoteFs, folderId, contactsEntriesDir, 3);
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.path.endsWith(".vcf")) continue;
        const name = entry.path.split("/").pop() ?? "";
        if (name.startsWith("android-")) continue;
        const bytes = await remoteFs.readFileFully(folderId, entry.path);
        const vcards = splitVcards(decoder.decode(bytes));
        for (const vcardText of vcards) {
          const parsed = parseVcard(vcardText);
          if (!parsed.displayName) continue;
          await client.upsertAndroidContact({
            displayName: parsed.displayName,
            phones: parsed.phones,
            emails: parsed.emails,
          });
          importedContacts += 1;
        }
      }
    }

    if (state.pim.calendarEnabled && state.pim.androidCalendarIntegration) {
      const entries = await readDirectoryEntriesRecursively(remoteFs, folderId, calendarEntriesDir, 3);
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.path.endsWith(".ics")) continue;
        const name = entry.path.split("/").pop() ?? "";
        if (name.startsWith("android-")) continue;
        const bytes = await remoteFs.readFileFully(folderId, entry.path);
        const text = decoder.decode(bytes);
        const eventBlocks = splitIcsEvents(text);
        if (eventBlocks.length === 0) {
          const parsedSingle = parseIcsEvent(text);
          if (parsedSingle.title && parsedSingle.startMs > 0 && parsedSingle.endMs > 0) {
            await client.upsertAndroidCalendarEvent({
              title: parsedSingle.title,
              startMs: parsedSingle.startMs,
              endMs: parsedSingle.endMs,
              allDay: false,
            });
            importedEvents += 1;
          }
          continue;
        }
        for (const eventText of eventBlocks) {
          const parsed = parseIcsEvent(eventText);
          if (!parsed.title || parsed.startMs <= 0 || parsed.endMs <= 0) continue;
          await client.upsertAndroidCalendarEvent({
            title: parsed.title,
            startMs: parsed.startMs,
            endMs: parsed.endMs,
            allDay: false,
          });
          importedEvents += 1;
        }
      }
    }

    const pimTreeRoot = `${root}/syncpeer/pim`;
    await ensurePimFolderFavorite(state, client, folderId, pimTreeRoot);
    await cachePimTreeOffline(state, client, folderId, remoteFs, pimTreeRoot);

    state.ui.uploadMessage =
      `Provider import complete. Imported ${importedContacts} contacts and ${importedEvents} events into Android.`;
  } catch (error) {
    reportActionError(state, "pim.provider_import.failed", error, {
      folderId: state.session.currentFolderId,
    });
  }
};
