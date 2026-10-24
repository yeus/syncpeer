import path from "node:path";
import { runWithPrivateSecretService } from "./private-secret-service.mjs";

// Keep the entire WebDriver child tree in one disposable Secret Service/XDG
// session. This avoids passing a Node wrapper as the Tauri application binary.
const runner = path.resolve("node_modules/@wdio/cli/bin/wdio.js");
const config = path.resolve("scripts/lan-test/wdio-shared-desktop.conf.ts");
const virtualDesktop = path.resolve("scripts/lan-test/virtual-desktop.sh");
process.exitCode = await runWithPrivateSecretService("bash", [
  virtualDesktop, process.execPath, "--import", "tsx", runner, "run", config,
]);
