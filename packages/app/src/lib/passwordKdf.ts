import { scryptPasswordKdf, type PasswordKdf } from "@syncpeer/core/kdf";

/** Runs the memory-hard derivation in a short-lived worker so the WebView UI
 * thread keeps rendering; falls back in-process where workers are unavailable.
 */
export const createWorkerPasswordKdf = (): PasswordKdf => async (passwordBytes, salt) => {
  if (typeof Worker === "undefined") return scryptPasswordKdf(passwordBytes, salt);
  const worker = new Worker(new URL("./passwordKdfWorker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      worker.onmessage = event => {
        const reply = event.data as { key?: number[]; error?: string };
        if (reply.error) reject(new Error(reply.error));
        else if (reply.key) resolve(new Uint8Array(reply.key));
        else reject(new Error("Password KDF worker returned an invalid response."));
      };
      worker.onerror = event => reject(new Error(event.message || "Password KDF worker failed."));
      worker.postMessage({ password: passwordBytes, salt });
    });
  } finally { worker.terminate(); }
};
