import { execFileSync } from "node:child_process";

const git = (args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const hasDiff = (args: string[]): boolean => {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
};

export const readSourceState = (): { commit: string; clean: boolean } => ({
  commit: git(["rev-parse", "HEAD"]),
  clean: !hasDiff(["diff", "--quiet"]) && !hasDiff(["diff", "--cached", "--quiet"]),
});

export const requireCleanSource = (state: { commit: string; clean: boolean }): void => {
  if (!state.clean) {
    throw new Error("LAN tests require no tracked or staged changes in the repository.");
  }
};
