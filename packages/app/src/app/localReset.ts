const confirmation = "RESET LOCAL DATA";
const warning =
  "This deletes Syncpeer-managed data on this device, including local settings, downloaded files, " +
  "unsynced edits, and its app-managed identity. External selected folders and other devices are not changed. " +
  "On Android, folder access must be granted again. Type RESET LOCAL DATA to continue.";

export const requestLocalDataReset = async ({
  invoke,
  prompt,
  clearLocalState,
  reload,
}: {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  prompt: (message: string) => string | null;
  clearLocalState: () => void;
  reload: () => void;
}): Promise<"cancelled" | "reset"> => {
  if (prompt(warning) !== confirmation) return "cancelled";
  await invoke("syncpeer_reset_local_data", { confirmation });
  clearLocalState();
  reload();
  return "reset";
};
