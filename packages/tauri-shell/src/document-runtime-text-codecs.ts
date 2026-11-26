import { TextEncoder as PolyfillTextEncoder, TextDecoder as PolyfillTextDecoder } from "@kayahr/text-encoding/no-encodings";

// WHATWG URL initializes UTF-8 codecs at module evaluation, before the
// document runtime's normal startup can install its remaining shims.
if (typeof globalThis.TextEncoder !== "function") globalThis.TextEncoder = PolyfillTextEncoder;
if (typeof globalThis.TextDecoder !== "function") globalThis.TextDecoder = PolyfillTextDecoder;
