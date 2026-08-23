import type { FileDownloadProgress } from "../core/model/remoteFs.js";

export interface DownloadRemoteFileFs {
  readFileFully: (
    folderId: string,
    path: string,
    onProgress?: (progress: FileDownloadProgress) => void,
  ) => Promise<Uint8Array>;
}

export const downloadRemoteFile = async (
  remoteFs: DownloadRemoteFileFs,
  args: {
    folderId: string;
    path: string;
    onProgress?: (progress: FileDownloadProgress) => void;
  },
): Promise<Uint8Array> => remoteFs.readFileFully(args.folderId, args.path, args.onProgress);
