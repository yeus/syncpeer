import { scryptPasswordKdf, type PasswordKdf } from "@syncpeer/core/kdf";

/** Runs the memory-hard derivation in a short-lived worker when the WebView can load it. */
export const createWorkerPasswordKdf = (): PasswordKdf => async (passwordBytes, salt) => {
  if (typeof Worker === "undefined") return scryptPasswordKdf(passwordBytes, salt);
  let worker: Worker;
  try { worker = new Worker(new URL("./passwordKdfWorker.ts", import.meta.url), { type: "module" }); }
  catch { return scryptPasswordKdf(passwordBytes, salt); }
  try {
    try { return await new Promise<Uint8Array>((resolve, reject) => {
      worker.onmessage = event => {
        const reply = event.data as { key?: number[]; error?: string };
        if (reply.error) reject(new Error(reply.error));
        else if (reply.key) resolve(new Uint8Array(reply.key));
        else reject(new Error("Password KDF worker returned an invalid response."));
      };
      worker.onerror = event => reject(new Error(event.message || "Password KDF worker failed."));
      worker.postMessage({ password: passwordBytes, salt });
    }); }
    catch { return await scryptPasswordKdf(passwordBytes, salt); }
  } finally { worker.terminate(); }
};
