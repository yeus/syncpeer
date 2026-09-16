export interface PersonalSpaceChange {
  id: string;
  deviceId: string;
  path: string[];
  parents: string[];
  value?: unknown;
  deleted?: true;
}

const pathKey = (path: readonly string[]) => JSON.stringify(path);

const canonical = (value: unknown, depth = 0): string => {
  if (depth > 16) throw new Error("Personal-space setting is too deeply nested.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("Invalid personal-space setting value.");
};

/** Resolve one complete, authenticated settings journal; never use arrival order as authority. */
export function resolvePersonalSpaceChanges(changes: readonly PersonalSpaceChange[]) {
  if (!Array.isArray(changes) || changes.length > 10000) throw new Error("Invalid personal-space changes.");
  const byId = new Map<string, PersonalSpaceChange>();
  const byPath = new Map<string, PersonalSpaceChange[]>();
  const fingerprints = new Map<string, string>();
  for (const change of changes) {
    if (!change || typeof change.id !== "string" || !change.id || change.id.length > 128 ||
      typeof change.deviceId !== "string" || !change.deviceId || change.deviceId.length > 128 ||
      !Array.isArray(change.path) || !change.path.length || change.path.length > 8 ||
      change.path.some((part: unknown) => typeof part !== "string" || !part || part.length > 1024) ||
      !Array.isArray(change.parents) || change.parents.length > 100 ||
      change.parents.some((parent: unknown) => typeof parent !== "string" || !parent) ||
      (change.deleted === true) === Object.hasOwn(change, "value")) {
      throw new Error("Invalid personal-space change.");
    }
    if (byId.has(change.id)) throw new Error("Duplicate personal-space change ID.");
    const fingerprint = change.deleted ? "deleted" : canonical(change.value);
    if (fingerprint.length > 1024 * 1024) throw new Error("Personal-space setting value is too large.");
    fingerprints.set(change.id, fingerprint);
    byId.set(change.id, change);
    const key = pathKey(change.path);
    byPath.set(key, [...byPath.get(key) ?? [], change]);
  }
  const referenced = new Set<string>();
  const children = new Map<string, string[]>();
  const remainingParents = new Map(changes.map(change => [change.id, change.parents.length]));
  for (const change of changes) {
    const parents = new Set<string>();
    for (const id of change.parents) {
      const parent = byId.get(id);
      if (!parent) throw new Error("Missing personal-space change ancestor.");
      if (pathKey(parent.path) !== pathKey(change.path) || id === change.id || parents.has(id)) {
        throw new Error("Invalid personal-space change ancestry.");
      }
      parents.add(id);
      referenced.add(id);
      children.set(id, [...children.get(id) ?? [], change.id]);
    }
  }
  const ready = changes.filter(change => change.parents.length === 0).map(change => change.id);
  let processed = 0;
  while (ready.length) {
    const id = ready.pop()!;
    processed++;
    for (const child of children.get(id) ?? []) {
      const remaining = remainingParents.get(child)! - 1;
      remainingParents.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  if (processed !== changes.length) throw new Error("Cyclic personal-space change ancestry.");
  const values: Array<{ path: string[]; value: unknown; heads: string[]; deleted?: true }> = [];
  const conflicts: Array<{ path: string[]; heads: string[]; changes: PersonalSpaceChange[] }> = [];
  for (const [key, group] of [...byPath].sort(([left], [right]) => left.localeCompare(right))) {
    const heads = group.filter(change => !referenced.has(change.id)).sort((left, right) => left.id.localeCompare(right.id));
    if (!heads.length) throw new Error("Cyclic personal-space change ancestry.");
    const path = JSON.parse(key) as string[];
    if (heads.length > 1 && heads.some(change => fingerprints.get(change.id) !== fingerprints.get(heads[0].id))) {
      conflicts.push({ path, heads: heads.map(change => change.id), changes: heads });
    } else values.push({ path, value: heads[0].value, heads: heads.map(change => change.id),
      ...(heads[0].deleted ? { deleted: true as const } : {}) });
  }
  return { values, conflicts };
}
