const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Encode unpadded base64url without browser-provided encoding helpers. */
const encodeBase64Url = (bytes: Uint8Array): string => {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET.charAt(first >> 2);
    encoded += BASE64URL_ALPHABET.charAt(((first & 3) << 4) | ((second === undefined ? 0 : second) >> 4));
    if (second === undefined) break;
    encoded += BASE64URL_ALPHABET.charAt(((second & 15) << 2) | ((third === undefined ? 0 : third) >> 6));
    if (third === undefined) break;
    encoded += BASE64URL_ALPHABET.charAt(third & 63);
  }
  return encoded;
};

export const generateMasterPassword = (
  randomBytes: (size: number) => Uint8Array = size => crypto.getRandomValues(new Uint8Array(size)),
): string => {
  const bytes = randomBytes(32);
  if (bytes.length !== 32) throw new Error("Secure random generation returned an unexpected length.");
  return encodeBase64Url(bytes);
};
