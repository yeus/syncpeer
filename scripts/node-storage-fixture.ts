import { before, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Keep diagnostics and their CLI subprocesses out of the user's durable app state. */
export function useTemporaryMetadataRoot() {
  let directory: string | undefined;
  const original = process.env.SYNCPEER_STATE_DIR;
  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "syncpeer-test-state-"));
    process.env.SYNCPEER_STATE_DIR = directory;
  });
  after(async () => {
    if (original === undefined) delete process.env.SYNCPEER_STATE_DIR;
    else process.env.SYNCPEER_STATE_DIR = original;
    if (directory) await rm(directory, { recursive: true, force: true });
  });
}
