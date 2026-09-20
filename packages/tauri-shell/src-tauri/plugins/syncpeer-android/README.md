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

When the Activity is backgrounded after a connection, the WebView-owned peer
session is closed before the service starts its own authenticated core session.
The service is the only background session owner, runs as a low-noise `dataSync`
foreground service, persists its bounded connection request through the
Keystore-backed vault, and reconnects after network/power policy changes or an
Android process restart. Returning to the Activity stops the service and waits
for that session to close before the UI session resumes. This handoff keeps the
ownership explicit: folders attached to the DocumentsProvider use their full
encrypted replica, while unattached folders still download only explicit
favorites. Peer-scoped saved passwords are resolved before an attached encrypted
folder is advertised after restart.

Acknowledged encrypted download ranges are journaled with the remote content
identity. They can be reused after the service or app restarts, but are discarded
when the remote identity changes. The document runtime also recreates its
JavaScript isolate after termination without reusing open handles or stale keys.
Startup and recovery failures retry after 1, 2, 4, 8 and 16 seconds, then fail
closed until Android recreates the service.

The service prefers AndroidX `JavaScriptSandbox` when it provides promise
results, message ports, array buffers, termination callbacks, and heap limits.
If that complete feature set is unavailable, the service runs the same packaged
document-runtime JavaScript in a hidden WebView. Both hosts remain headless,
live in the service process, and use the same private storage, network, and timer
ports; the fallback does not add an Activity, browser UI, or second sync logic
implementation.

The Android picker exposes create, file rename, and delete where core can perform
them safely. Deletion uses core's encrypted version archive. Android's
DocumentsProvider API has no restore-version callback, so version browsing and
restoration belong in Syncpeer's own folder UI rather than being advertised as a
picker operation.

Folder storage can be moved back to the legacy plaintext cache explicitly. The
copy is verified before encrypted contents are removed, so failed reverse
migrations retain encrypted ownership and can be retried. The app exposes this
as a per-folder operation rather than changing the default encrypted policy.

The local master password can be changed while the vault is unlocked. Rotation
rewrites the encrypted record and the remembered Keystore-backed secret as one
recoverable operation. Android biometric unlock is an optional app gate: it
authenticates before the remembered secret is used, but it never stores or
returns the folder password itself.

The Folders view links to a separate settings/new-folder page with normal URL and
Back navigation. Creating a local folder does not automatically share it remotely.

### Verification and limits

The complete Android compatibility suite targets Android 10 (API 29), which is
the oldest full-support target. The development shell includes a Play Store AVD
named `syncpeer-api29`. The normal workflow provisions its WebView automatically
from the current Google-signed WebView in the API 36 Play Store image, so no
Play Store account or manual update is required:

```sh
npm run test:android
```

This builds the x86_64 test APK once, starts API 36 to run the focused
transfer-service smoke test and capture its WebView pair, then starts API 29,
installs that pair, and runs the Android 10 compatibility suite (including a
real emulator reboot). It then starts a real host Syncthing peer and a separate,
non-launcher synthetic editor APK. That APK receives a normal persisted SAF grant and performs
create, write, rename, read and delete operations through the DocumentsProvider.
The peer gate checks host convergence in both directions, interrupts a measured
in-progress 4 MiB/32-block replica transfer by sending SIGKILL to the emulator,
cold-starts it and verifies the entire recovered document through the editor APK,
then repeats the cold restart with a durable provider edit held offline. The
ordinary transfer suite separately covers 128 MiB. This real-peer gate passed on
the managed API 29 emulator on 2026-09-20. The runner uninstalls only the Syncpeer
app, instrumentation package and synthetic editor from each managed emulator;
do not use these AVDs for persistent manual test data. Emulators are cleaned up
when a phase fails. No Play Store account or manual WebView update is required.

For debugging one profile at a time, the lower-level commands remain available:

```sh
npm run android:emulator:compat
npm run test:android:compat
npm run android:emulator:modern
npm run test:android:modern-smoke
```

The modern smoke check verifies Android 14+'s user-initiated transfer job
boundary without duplicating the complete Android 10 suite.

Core tests cover password rotation, interrupted migrations, verified plaintext
deletion, reverse migration, and restart-safe encrypted storage. Android
instrumentation tests cover the native secure-store policy, Keystore-backed
remembered secret, encrypted background-session request persistence,
file-picker access without an Activity, and process restarts. The Android E2E
harness also checks the service handoff when a remote fixture is configured.
Set `SYNCPEER_ANDROID_REBOOT_CHECK=1` with an unlocked emulator/device to add
a real reboot between the Keystore and document-runtime phases; this remains
optional because it needs an attached ADB device and cannot run in ordinary CI.

The remembered secret is protected by Android Keystore and private no-backup
storage. Deleting app data or losing the Keystore key can still destroy access;
there is no export/recovery workflow for an automatically generated secret until
the user sets a master password. Equivalent encrypted-folder integration on
non-Android platforms remains unchanged.
