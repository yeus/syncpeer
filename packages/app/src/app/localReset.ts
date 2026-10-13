const confirmation = "RESET LOCAL DATA";
const warning =
  "This deletes Syncpeer-managed data on this device, including local settings, downloaded files, " +
  "unsynced edits, and its app-managed identity. External selected folders and other devices are not changed. " +
  "Syncpeer will close after reset. Packaged Linux builds restart automatically; " +
  "development builds and Android must be opened again manually. " +
  "On Android, folder access must be granted again. Type RESET LOCAL DATA to confirm the deletion and continue.";

export const requestLocalDataReset = async ({
  invoke,
  prompt,
  clearLocalState,
}: {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  prompt: (message: string) => string | null;
  clearLocalState: () => void;
}): Promise<"cancelled" | "reset"> => {
  if (prompt(warning) !== confirmation) return "cancelled";
  await invoke("syncpeer_reset_local_data", { confirmation });
  clearLocalState();
  return "reset";
};
