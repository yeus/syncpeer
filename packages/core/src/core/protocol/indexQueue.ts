export interface FolderIndexMessage {
  folder?: unknown;
  files?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface PendingIndexFrame {
  kind: "index" | "update";
  index: FolderIndexMessage;
}

const mergeFilesByName = (
  earlier: Array<Record<string, unknown>>,
  later: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> => {
  const named = new Map<string, Record<string, unknown>>();
  const unnamed: Array<Record<string, unknown>> = [];
  for (const file of [...earlier, ...later]) {
    const name = typeof file.name === "string" ? file.name : "";
    if (name) named.set(name, file);
    else unnamed.push(file);
  }
  return [...named.values(), ...unnamed];
};

export const coalescePendingIndexFrame = (
  pending: PendingIndexFrame,
  incoming: PendingIndexFrame,
): PendingIndexFrame => {
  if (incoming.kind === "index") return incoming;
  return {
    kind: pending.kind,
    index: {
      ...pending.index,
      ...incoming.index,
      files: mergeFilesByName(
        Array.isArray(pending.index.files) ? pending.index.files : [],
        Array.isArray(incoming.index.files) ? incoming.index.files : [],
      ),
    },
  };
};
