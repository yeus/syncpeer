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
    status: () => Promise<{ vault: { phase: string } }>;
    rememberFolder: (folder: { id: string; label: string }) => Promise<unknown>;
  },
  folders: readonly { id: string; label: string }[],
  onError: (error: unknown) => void,
): void => {
  if (!folders.length) return;
  void (async () => {
    if ((await documents.status()).vault.phase !== "unlocked") return;
    for (const folder of folders) {
      await documents.rememberFolder({ id: folder.id, label: folder.label || folder.id });
    }
  })().catch(onError);
};
