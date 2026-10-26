const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const decodeTable = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < alphabet.length; index += 1) {
    table[alphabet.charCodeAt(index)] = index;
  }
  return table;
})();

/** Compact binary encoding for the Android JSON IPC boundary. */
export const encodeBase64 = (bytes: Uint8Array): string => {
  const output: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const second = offset + 1 < bytes.length ? bytes[offset + 1] : 0;
    const third = offset + 2 < bytes.length ? bytes[offset + 2] : 0;
    output.push(
      alphabet[first >> 2],
      alphabet[((first & 0x03) << 4) | (second >> 4)],
      offset + 1 < bytes.length ? alphabet[((second & 0x0f) << 2) | (third >> 6)] : "=",
      offset + 2 < bytes.length ? alphabet[third & 0x3f] : "=",
    );
  }
  return output.join("");
};

export const decodeBase64 = (value: string, maximumBytes = 1024 * 1024): Uint8Array => {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new Error("Invalid base64 payload.");
  }
  if (value.length > maximumBytes * 4 / 3 + 4) throw new Error("Base64 payload exceeds its limit.");
  if (value.length === 0) return new Uint8Array(0);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const size = (value.length / 4) * 3 - padding;
  if (size < 0 || size > maximumBytes) throw new Error("Base64 payload exceeds its limit.");
  const bytes = new Uint8Array(size);
  let output = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const one = value.charCodeAt(offset);
    const two = value.charCodeAt(offset + 1);
    const three = value.charCodeAt(offset + 2);
    const four = value.charCodeAt(offset + 3);
    const a = one < 128 ? decodeTable[one] : -1;
    const b = two < 128 ? decodeTable[two] : -1;
    const c = three === 61 ? 0 : three < 128 ? decodeTable[three] : -1;
    const d = four === 61 ? 0 : four < 128 ? decodeTable[four] : -1;
    const lastQuartet = offset + 4 === value.length;
    if (a < 0 || b < 0 || c < 0 || d < 0 ||
      (!lastQuartet && (three === 61 || four === 61)) ||
      (three === 61 && four !== 61) ||
      (four === 61 && (three !== 61 && offset + 3 >= value.length))) {
      throw new Error("Invalid base64 payload.");
    }
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < size) bytes[output++] = (combined >> 16) & 0xff;
    if (output < size) bytes[output++] = (combined >> 8) & 0xff;
    if (output < size) bytes[output++] = combined & 0xff;
  }
  return bytes;
};
