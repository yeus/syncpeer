/** Stable SAF identity: the Syncthing folder ID and its relative path.
 * The folder ID is component-encoded so it cannot collide with path separators.
 * Android's DocumentsContract separately URI-encodes this entire document ID.
 */
export const encodeDocumentId = (folderId: string, path: string): string => {
  if (!folderId) throw new Error("Invalid document folder ID.");
  return `${encodeURIComponent(folderId)}/${path}`;
};

export const decodeDocumentId = (id: string): { folderId: string; path: string } => {
  const separator = id.indexOf("/");
  if (separator <= 0) throw new Error("Invalid document ID.");
  const encodedFolderId = id.slice(0, separator);
  let folderId: string;
  try { folderId = decodeURIComponent(encodedFolderId); }
  catch { throw new Error("Invalid document ID."); }
  if (!folderId || encodeURIComponent(folderId) !== encodedFolderId) throw new Error("Invalid document ID.");
  return { folderId, path: id.slice(separator + 1) };
};
