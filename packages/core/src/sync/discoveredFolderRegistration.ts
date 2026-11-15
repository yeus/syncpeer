/** Undefined preserves ordinary peer discovery; [] forbids implicit registration. */
export const consentedDiscoveredFolders = <T extends { id: string }>(
  folders: readonly T[], consentedFolderIds?: readonly string[],
): T[] => consentedFolderIds === undefined ? [...folders]
  : folders.filter(folder => consentedFolderIds.includes(folder.id));

/** Persist advertised roots after the peer connection has been acknowledged.
 * Metadata persistence must never delay or invalidate a live BEP handshake.
 */
export const deferDiscoveredFolderRegistration = (
  documents: {
    status: () => Promise<{ vault: { phase: string }; folders?: readonly { id: string }[] }>;
    rememberFolder: (folder: { id: string; label: string }) => Promise<unknown>;
  },
  folders: readonly { id: string; label: string }[],
  onError: (error: unknown) => void,
): void => {
  if (!folders.length) return;
  void (async () => {
    const state = await documents.status();
    if (state.vault.phase !== "unlocked") return;
    const registered = new Set((state.folders ?? []).map(folder => folder.id));
    for (const folder of folders) {
      if (registered.has(folder.id)) continue;
      await documents.rememberFolder({ id: folder.id, label: folder.label || folder.id });
      registered.add(folder.id);
    }
  })().catch(onError);
};
