import { TextEncoder, TextDecoder } from "@kayahr/text-encoding/no-encodings";
import structuredClone from "@ungap/structured-clone";
import { AbortController, AbortSignal } from "abort-controller";

// This isolated entry executes before core's dependencies construct text codecs.
Object.assign(globalThis, { TextEncoder, TextDecoder, structuredClone, AbortController, AbortSignal });
if (!("throwIfAborted" in AbortSignal.prototype)) Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
  value(this: AbortSignal) { if (this.aborted) throw new Error("Operation cancelled."); },
});
