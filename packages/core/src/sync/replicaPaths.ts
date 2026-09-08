/** Syncthing root control files and Syncpeer's private storage are never replicated. */
export const isInternalReplicaPath = (path: string): boolean => {
  const parts = path.split("/");
  return [".stfolder", ".stignore", ".stversions"].includes(parts[0]) ||
    parts.some(part => part === ".stversions" || part === ".syncpeer-trash" ||
      part.startsWith(".syncpeer-") || part.includes(".syncpeer-conflict-"));
};

export const assertReplicaPath = (path: string): void => {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
      path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Invalid replica path.");
  }
};
