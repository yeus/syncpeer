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
downloads are copied and verified before ownership switches; the old plaintext
copy is removed only after verification. If cleanup or verification fails, the
encrypted copy is not attached and the original remains available for retry.
External-storage imports can require manual handling. Failed preparation never
silently falls back to writing new Android downloads in plaintext.

Folder storage can be moved back to the legacy plaintext cache explicitly. The
copy is verified before encrypted contents are removed, so failed reverse
migrations retain encrypted ownership and can be retried. The app exposes this
as a per-folder operation rather than changing the default encrypted policy.

The local master password can be changed while the vault is unlocked. Rotation
rewrites the encrypted record and the remembered device-protected secret as one
recoverable operation. Android biometric unlock is an optional app gate: it
authenticates before the remembered secret is used, but it never stores or
returns the folder password itself.

The Folders view links to a separate settings/new-folder page with normal URL and
Back navigation. Creating a local folder does not automatically share it remotely.

### Verification and limits

Core tests cover password rotation, interrupted migrations, verified plaintext
deletion, reverse migration, and restart-safe encrypted storage. Android
instrumentation tests cover the native secure-store policy, Keystore-backed
remembered secret, file-picker access without an Activity, and process restarts.
Set `SYNCPEER_ANDROID_REBOOT_CHECK=1` when running the Android E2E harness with
an unlocked emulator/device to add a real reboot between those phases; this is
optional because it needs an attached ADB device and cannot run in ordinary CI.

The remembered secret is protected by Android Keystore and private no-backup
storage. Deleting app data or losing the Keystore key can still destroy access;
there is no export/recovery workflow for an automatically generated secret until
the user sets a master password. Equivalent encrypted-folder integration on
non-Android platforms remains unchanged.
