# Syncpeer 0.6: usable Android release

Status: proposed release scope, based on the source and test review of 2026-09-18.
This is a release gate, not a claim that the items below already work on a phone.
[`remaining_issues.txt`](remaining_issues.txt) remains the broader backlog.

## Release promise

On a supported Android phone, a person can connect to an approved Syncthing or
Syncpeer device, select individual files or directories as favorites, use the
downloaded documents while offline through Android's document picker, edit them
in another app, and have those edits synchronize in both directions when a peer
is available. The app stores its replica and sensitive local state encrypted by
default. The master password unlocks the personal space; an explicitly enabled,
OS-protected remembered unlock avoids asking for it at every subsequent start.

The supported Android sync unit for 0.6 is the selected favorite. Registering or
connecting to a folder must not download its entire contents. A user-selected
SAF export is an explicit plaintext export boundary, clearly identified before
data is written there. A normal Syncthing-compatible folder on disk is also
plaintext by design and is outside this Android encrypted-replica promise.

## Release blockers

### Current implementation checkpoint

The first implementation slice is now in progress: the Android service owns a
direct-file favorite reconciliation pass while its peer session is connected.
It runs after connection, after a document handle is released, and on a bounded
15-second service interval. It writes downloads through the encrypted document
owner, publishes small offline edits, persists verified baselines, and reports
conflicts without replacing either copy. Focused tests cover initial download,
offline upload, and concurrent-change protection.

This does not yet satisfy the release promise. Directory favorites, deletion and
rename propagation, durable transfer progress across service termination, large
streaming uploads, and a real Android plus peer acceptance test remain required.

### 1. Give the Android service ownership of selected-file synchronization

- Move favorite selection, transfer scheduling, durable baselines, and retry
  state into the service-owned runtime. The current favorite transfer action
  returns when the UI is hidden or its session is disconnected; the background
  service currently maintains a peer session without completing that policy.
- Download a newly selected favorite promptly, subject to the user's transfer
  policy. Resume interrupted work after Activity/process recreation, network
  loss, and reboot. Respect metered-network and battery constraints without
  implying that Android guarantees continuous background execution.
- Publish offline edits, including changes made through DocumentsProvider.
  Define deletion and rename behavior and preserve both sides of a conflict for
  user resolution. Do not silently replace an unverified local edit.
- Bound memory use for large uploads and downloads. Avoid whole-file reads into
  the WebView during publication.

### 2. Complete the phone's folder and offline workflow

- Provide explicit registration/import for an existing encrypted Syncthing
  folder, including folder-password recovery and clear approval of the peer and
  folder identity. Keep a registered folder browsable without subscribing its
  full contents.
- Make offline directory listings and favorite availability understandable in
  the UI. A never-browsed directory currently has no offline listing; decide
  whether 0.6 prefetches selected directory metadata or shows that limit
  plainly. The DocumentsProvider must remain usable after Activity and process
  recreation, even with no network.
- Show per-favorite progress, queued/paused/error state, and a way to retry or
  resolve a conflict. Removing a favorite must have clear, separate semantics
  from deleting a remote file or discarding a locally edited copy.

### 3. Finish the local-encryption boundary

- Encrypt or migrate remaining sensitive app-controlled state: legacy cache and
  partial-transfer metadata, UI/WebView state, folder registry, and the keyless
  ciphertext-history index. Preserve the index's required locked operation and
  document any unavoidable structural leakage. Ensure old plaintext copies are
  removed only after a verified migration.
- Verify that fresh installs use encrypted document storage, SQLCipher metadata,
  and protected native identity storage, and that legacy plaintext identity
  files fail safely. Audit backups, temporary files, and diagnostics as well as
  the main database. Update [`LOCAL_STORAGE.md`](LOCAL_STORAGE.md), whose SQLite
  and native-identity description predates current code.
- Treat SAF output as a deliberate export. Never present an exported plaintext
  file as part of the encrypted local replica.

### 4. Make unlock and recovery reliable

- Set and explain the remembered-unlock choice during onboarding. Verify the
  master password is needed on first unlock and after explicit lock, while
  subsequent starts use Android Keystore only when the user enabled remembering.
- Move the memory-hard bootstrap KDF off the UI thread so creation and unlock
  do not freeze the interface. Test wrong password, missing Keystore material,
  process death, reboot, reset, and recovery without silently creating a new
  empty space or reusing stale keys.
- Provide a usable export/import path for the existing offline personal-space
  backup if that backup is the recovery story offered in 0.6. State clearly
  that it does not contain downloaded documents or device identity keys.

### 5. Prove interoperability and durability on devices

- Run mixed Syncthing/Syncpeer tests for initial transfer, edits in both
  directions, reconnect, conflict, deletion, wrong password, tampered or
  truncated data, and large bounded reads. Existing CLI peer and Syncthing
  tests establish a foundation but do not prove the Android workflow.
- Run a combined Android DocumentsProvider plus real-peer workflow after
  Activity and process recreation. The self-contained emulator runner currently
  skips its network UI workflow without an external peer fixture.
- Run the release path on physical phones across the supported Android versions:
  fresh install, upgrade from 0.5, offline picker access, another app's edit,
  background transfer, force-stop/relaunch, reboot, and storage recovery.
  Include startup timeout and repeated-failure/retry checks. Emulator reboot
  alone is not a power-loss durability test.

## Release acceptance scenario

Use synthetic files and isolated test peers. On a physical phone:

1. Create or recover a personal space, opt into remembered unlock, and approve
   one Syncthing peer. Register its encrypted folder without downloading all
   files. Repeat connection with a Syncpeer peer.
2. Favorite one file and one directory. Confirm only selected content is
   downloaded and appears in Android's document picker. Disconnect the network,
   restart the Activity and process, then browse and open the available content.
3. Edit a selected document through another Android app while offline. Reconnect
   and confirm the peer receives that edit. Change the peer copy and confirm the
   phone receives it. Exercise a concurrent edit and a deletion without data
   loss or silent overwrite.
4. Reboot and verify remembered unlock and recovery of queued transfers.
   Explicitly lock, then verify that the master password is required. Check that
   app-owned on-disk data and migration leftovers meet the encryption policy.
5. Repeat failure cases with wrong folder passwords, corrupt metadata/blocks,
   interrupted large transfers, and repeated service startup failure. Errors
   must be actionable, and recovery must fail closed.

Do not tag 0.6 as meeting this promise until the scenario passes on the release
build. Record the tested Android versions and devices in the release notes.

## Outside this Android 0.6 gate

Linux FUSE, desktop folder onboarding and lifecycle controls, Windows/macOS/iOS
validation, browser storage, and large-catalog optimization remain in
[`remaining_issues.txt`](remaining_issues.txt). Cross-device personal-space
settings, owned-device roster/pairing, revocation, and automatic propagation of
favorites also remain there. If 0.6 is advertised as a shared personal space
across owned devices, those features become release blockers and need their own
end-to-end recovery and compromise tests.
