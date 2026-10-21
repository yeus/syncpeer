export const generateMasterPassword = (
  randomBytes: (size: number) => Uint8Array = size => crypto.getRandomValues(new Uint8Array(size)),
): string => {
  const bytes = randomBytes(32);
  if (bytes.length !== 32) throw new Error("Secure random generation returned an unexpected length.");
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};
