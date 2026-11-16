/** Only missing legacy credentials are migrated; ordinary unlocks are read-only. */
export const loadVerifiedFolderPasswords = async (
  credentials: {
    load: () => Promise<Record<string, string>>;
    merge: (passwords: Record<string, string>) => Promise<void>;
  },
  pending: Readonly<Record<string, string>>,
): Promise<Record<string, string>> => {
  const saved = await credentials.load();
  for (const [id, password] of Object.entries(pending)) {
    if (saved[id] !== undefined && saved[id] !== password) {
      throw new Error("Conflicting saved folder passwords require review.");
    }
  }
  const missing = Object.keys(pending).some(id => saved[id] === undefined);
  if (!missing) return saved;

  const merged = { ...pending, ...saved };
  await credentials.merge(merged);
  const verified = await credentials.load();
  if (Object.entries(merged).some(([id, value]) => verified[id] !== value)) {
    throw new Error("Encrypted credentials could not be verified; legacy data was retained.");
  }
  return verified;
};
