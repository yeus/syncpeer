// JavaScriptEngine has no browser text codecs; install the standard UTF-8 shim
// before loading core. Encryption and authenticated file layout stay in core.
import "./document-runtime-polyfills.js";
import { createDocumentFilesystem } from "../../core/src/sync/documentFilesystem.js";
import { dispatchDocumentCommand } from "../../core/src/sync/documentCommands.js";
import { createNativeFilesystem } from "../../core/src/sync/nativeFilesystem.js";
import { deriveUntrustedFolderCrypto } from "../../core/src/core/model/untrusted.js";
import { createEncryptedDownloadSink, loadEncryptedDiskMetadata, readEncryptedDiskRange } from "../../core/src/sync/encryptedFilesystem.js";

async function startDocuments(android: { getNamedPort: (name: string) => Promise<MessagePort> }) {
  const port = await android.getNamedPort("storage");
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  port.onmessage = event => {
    const reply = JSON.parse(event.data);
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error) task.reject(new Error(reply.error)); else task.resolve(reply.result);
  };
  const request = (input: object): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject });
    port.postMessage(JSON.stringify({ id, ...input }));
  });
  const native = (input: object) => request({ method: "storage", input });
  const openStorage = async (id: string) => createNativeFilesystem(native, String(await request({ method: "root", idValue: id })));
  const secret = (operation: string, value?: string) => request({ method: "secret", operation, secret: value });
  const documents = createDocumentFilesystem({ profileId: "documents", profile: await openStorage("profile"), openStorage,
    deviceCounterId: String(await request({ method: "counter" })),
    randomBytes: async size => new Uint8Array(await request({ method: "random", size }) as number[]),
    rememberedSecret: { load: async () => await secret("load") as string | null, save: async value => { await secret("save", value); },
      remove: async () => { await secret("remove"); }, isDeviceUnlocked: async () => await secret("isDeviceUnlocked") === true } });
  await documents.initialize(true);
  return { command: (input: unknown) => dispatchDocumentCommand(documents, input), close: documents.close };
}

Object.defineProperty(globalThis, "syncpeerDocumentsCore", {
  value: { deriveUntrustedFolderCrypto, createEncryptedDownloadSink, loadEncryptedDiskMetadata, readEncryptedDiskRange, startDocuments },
  writable: false,
  configurable: false,
});
