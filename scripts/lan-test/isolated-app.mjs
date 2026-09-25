#!/usr/bin/env node
import path from "node:path";
import { runWithPrivateSecretService } from "./private-secret-service.mjs";

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary)) {
  throw new Error("Pass the absolute packaged Tauri executable path.");
}
process.exitCode = await runWithPrivateSecretService(binary, []);
