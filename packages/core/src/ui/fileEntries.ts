import type { FileEntry } from "../core/model/remoteFs.js";

export type FileEntrySortMode = "name" | "modified" | "size" | "type";

const compareNames = (left: FileEntry, right: FileEntry): number =>
  left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase()) ||
  left.name.localeCompare(right.name);

const compareDirectoriesFirst = (left: FileEntry, right: FileEntry): number => {
  if (left.type === right.type) return 0;
  return left.type === "directory" ? -1 : 1;
};

const fileExtension = (entry: FileEntry): string => {
  if (entry.type === "directory") return "";
  const separator = entry.name.lastIndexOf(".");
  return separator > 0 ? entry.name.slice(separator + 1).toLocaleLowerCase() : "";
};

const compareEntries = (mode: FileEntrySortMode) =>
  (left: FileEntry, right: FileEntry): number => {
    const directoryOrder = compareDirectoriesFirst(left, right);
    if (directoryOrder !== 0) return directoryOrder;
    if (mode === "modified") {
      return right.modifiedMs - left.modifiedMs || compareNames(left, right);
    }
    if (mode === "size") {
      return right.size - left.size || compareNames(left, right);
    }
    if (mode === "type") {
      return fileExtension(left).localeCompare(fileExtension(right)) || compareNames(left, right);
    }
    return compareNames(left, right);
  };

export const sortAndFilterFileEntries = (
  entries: FileEntry[],
  sortMode: FileEntrySortMode,
  nameFilter: string,
): FileEntry[] => {
  const query = nameFilter.trim().toLocaleLowerCase();
  return entries
    .filter((entry) => query === "" || entry.name.toLocaleLowerCase().includes(query))
    .sort(compareEntries(sortMode));
};
