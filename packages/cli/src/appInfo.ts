import { execFileSync } from "node:child_process";
import fs from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import {
  classifyRuntimeArchitecture,
  classifyRuntimePlatform,
  createAppBuildInfo,
  formatAppBuildInfo,
  type AppBuildInfo,
} from "@syncpeer/core";

interface GeneratedBuildMetadata {
  buildCommit?: unknown;
  buildTimeUtc?: unknown;
}

const readGeneratedBuildMetadata = (): GeneratedBuildMetadata => {
  try {
    return JSON.parse(
      fs.readFileSync(new URL("./build-info.json", import.meta.url), "utf8"),
    ) as GeneratedBuildMetadata;
  } catch {
    return {};
  }
};

const resolveBuildCommit = (generated: GeneratedBuildMetadata): string => {
  const configured = [
    generated.buildCommit,
    process.env.SYNCPEER_BUILD_COMMIT,
    process.env.GIT_COMMIT,
    process.env.CI_COMMIT_SHA,
    process.env.CI_COMMIT_SHORT_SHA,
  ].find((value) => typeof value === "string" && value.trim());
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

const resolveBuildTimeUtc = (generated: GeneratedBuildMetadata): string => {
  const configured = [
    generated.buildTimeUtc,
    process.env.SYNCPEER_BUILD_TIME_UTC,
  ].find((value) => typeof value === "string" && value.trim());
  if (typeof configured === "string" && !Number.isNaN(Date.parse(configured))) {
    return configured.trim();
  }
  const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isFinite(sourceDateEpoch) && sourceDateEpoch >= 0) {
    return new Date(sourceDateEpoch * 1000).toISOString();
  }
  return "unknown";
};

export const getCliBuildInfo = (): AppBuildInfo => {
  const generated = readGeneratedBuildMetadata();
  const coreVersion = packageJson.dependencies?.["@syncpeer/core"];
  return createAppBuildInfo({
    appVersion: packageJson.version,
    coreVersion,
    buildCommit: resolveBuildCommit(generated),
    buildTimeUtc: resolveBuildTimeUtc(generated),
    buildMode: process.env.SYNCPEER_BUILD_MODE === "development"
      ? "development"
      : "production",
    runtimeEnvironment: "node",
    runtimeSurface: "cli",
    platform: classifyRuntimePlatform(process.platform),
    architecture: classifyRuntimeArchitecture(process.arch),
  });
};

export { formatAppBuildInfo };
