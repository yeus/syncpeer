import { runWithPrivateSecretService } from "./lan-test/private-secret-service.mjs";

runWithPrivateSecretService("cargo", ["test", "--manifest-path", "packages/tauri-shell/src-tauri/Cargo.toml",
  "--lib", "vault_secret::tests::private_secret_service_round_trip", "--", "--ignored", "--exact"],
{ SYNCPEER_PRIVATE_KEYRING_TEST: "1" }).then(code => { process.exitCode = code; }).catch(error => {
  console.error("Private native credential fixture failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
