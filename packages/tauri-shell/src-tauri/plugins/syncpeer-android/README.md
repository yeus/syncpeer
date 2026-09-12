# Tauri Plugin syncpeer-android

## Local folder service

The Android DocumentsProvider exposes one Syncpeer root. Its children come from
the persistent local folder registry, not the currently connected peer. An empty
installation has an empty root; known folders remain visible across peer switches
and restarts. Inside each folder, only downloaded or locally created content is
exposed, never placeholder files from the remote index.

New installations initialize encrypted storage automatically. A random unlock
secret is wrapped by Android Keystore and stored in private, non-backed-up app
storage before the encrypted credential record is created. After the first normal
device unlock following reboot, the service can restore access without an app
password. This is device-protected access, not biometric authorization on every
file read. Existing manually locked storage still requires its old password.

Discovered folders initially need only a persistent name and identifier. Encrypted
remote folders acquire local encryption credentials after their password is
available; the local copy uses that same password. Other new folders receive
independent cryptographically random passwords. Remote connection passwords are
also saved in the encrypted credential record; browser copies are removed only
after a successful protected save. Changing an existing folder's encryption
password is rejected until a migration can safely rewrite its contents.

Downloads use the same storage owner as the DocumentsProvider. Existing private
downloads are copied and verified before ownership switches; originals remain as
backups. External-storage imports can require manual handling. Failed preparation
never silently falls back to writing new Android downloads in plaintext.

The Folders view links to a separate settings/new-folder page with normal URL and
Back navigation. Creating a local folder does not automatically share it remotely.

### Remaining work and verification

- Reversible per-folder encryption changes, including restart-safe migration,
  password rotation, and verified removal of original plaintext copies.
- Optional user-selected master-password/recovery and biometric app-lock controls,
  kept distinct from revoking file-provider access.
- Android device tests covering reboot, secure-store failures, file-picker URI
  grants, and upgrade from existing downloads. Core restart tests use synthetic
  storage and do not prove hardware Keystore behavior.
- Equivalent encrypted-folder integration on non-Android platforms; their current
  cache behavior is unchanged.

Until migration cleanup exists, do not claim that all pre-existing local copies
are encrypted. App-data deletion or loss of the Keystore key can also destroy
access; there is no recovery/export workflow for automatically generated secrets
in this change.
