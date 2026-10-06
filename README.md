# Syncpeer

Syncpeer is a lightweight, local-first Syncthing-compatible client for desktop, Android, the command line, and TypeScript applications.

It started as an experiment in making Syncthing protocol work accessible outside the Go ecosystem. The larger goal is now broader: keep the interoperability and decentralized connectivity that make Syncthing useful, while providing a smaller client with encrypted local storage, offline browsing, explicit owned-device trust, and a mobile-friendly architecture.

Syncpeer is still pre-1.0 and does not implement every Syncthing feature.

## Why Syncpeer exists

Syncthing is an excellent decentralized synchronization protocol and ecosystem, but a full Syncthing node is not always the right shape for a lightweight desktop or mobile application.

Syncpeer is exploring a different client shape:

- **Keep Syncthing compatibility.** Syncpeer speaks normal TLS/BEP and uses Syncthing discovery and relay infrastructure instead of inventing a Syncpeer-only wire protocol.
- **Stay lightweight.** Core protocol and product logic live in TypeScript and are shared by the CLI, desktop app, Android app, and tests.
- **Work offline.** Browsed metadata, selected favorites, and Syncpeer-managed replicas can remain useful when peers are disconnected.
- **Protect app-owned data.** Private Syncpeer storage, remembered credentials, recovery material, and encrypted replicas are handled separately from ordinary plaintext Syncthing folders.
- **Make multiple personal devices feel like one trusted space.** Owned devices can pair explicitly, share settings and approved folder credentials, revoke devices, and recover from device loss without depending on a central Syncpeer account service.
- **Avoid a mandatory Syncpeer server.** Peers can find each other through LAN discovery, official Syncthing global discovery, direct connections, and the standard Syncthing relay pool.

The aim is not to replace Syncthing. It is to build a smaller client that remains interoperable with it while offering a different local UX and security model.

## Interfaces

- TypeScript library: `@syncpeer/core`
- CLI
- Linux desktop app (Svelte + Tauri)
- Android app (Svelte + Tauri)

## What Syncpeer can do

The current codebase includes the following capabilities at varying levels of maturity. The canonical implementation/verification status for each one is tracked in `SYSTEM_DEFINITION.csv`:
- Syncthing-compatible TLS identities and device IDs
- BEP hello/framing, index exchange, block transfer, and session handling
- Remote folder listing and directory browsing
- Bidirectional file and folder synchronization
- Uploads and downloads with progress/cancellation
- Favorite folders and files with offline cached state
- Encrypted Syncpeer-managed local replicas
- Conflict-preserving synchronization and explicit conflict resolution
- LAN discovery
- Official Syncthing global discovery
- Direct TCP connections and relay fallback through the standard Syncthing relay pool
- Relay-only operation when direct connectivity is unavailable
- Persistent device identity and connection settings
- Owned-device pairing with matching six-digit confirmation codes
- Signed personal-space device membership with revocation
- Cross-device settings and approved encrypted-folder credential propagation
- Personal-space backup and separate recovery-kit workflow
- OS-protected remembered unlock secrets
- Android background synchronization
- Android DocumentsProvider integration for system Files/document access
- Android compatibility coverage across API 24, API 29, and API 36
- CLI browsing, transfer, folder synchronization, versioning, deletion, discovery, and diagnostics

The detailed implementation and validation status for each behavior lives in
[`SYSTEM_DEFINITION.csv`](./SYSTEM_DEFINITION.csv).

## How it works

### 1. Syncthing-compatible transport and synchronization

Syncpeer uses Syncthing-compatible device identities, TLS, BEP messages, folder indexes, block requests, LAN discovery, global discovery, and relay infrastructure.

Two Syncpeer peers use the same BEP path used for Syncthing interoperability; Syncpeer does not require a Syncpeer-specific transport protocol.

Connection selection can use:

1. direct configured addresses,
2. LAN discovery,
3. official Syncthing global discovery,
4. direct TCP when reachable, and
5. the standard Syncthing relay pool when direct connectivity is unavailable.

The relay is a transport intermediary, not a Syncpeer account or storage server.

### 2. Personal space: trust between your own devices

Syncpeer's **personal space** is the trust layer for devices that belong to the same person.

A new device joins through an explicit pairing flow:

1. one owned device creates a short-lived invitation,
2. the joining device connects over LAN or relay,
3. both devices derive the pairing material,
4. both display the same six-digit confirmation code,
5. the user confirms the match,
6. the new device receives signed membership and encrypted shared settings.

Membership is signed and hash-chained. Devices have stable signing slots and can be revoked. A revoked device is excluded from future personal-space share targets.

This trust layer is intentionally separate from ordinary Syncthing peer approval.

### 3. Shared settings and folder credentials

The personal space includes a hidden encrypted settings replica.

It carries authenticated changes for data that should follow the owner across devices, including:

- shared folder policy,
- trusted-device membership,
- approved encrypted-folder credentials,
- retention/versioning configuration,
- selected cross-device settings.

Some state remains deliberately device-local, such as local attachment choices and device-scoped favorites/exclusions where appropriate.

When one approved device creates an encrypted folder, its credential can be published as a signed personal-space change. Another already-approved device can learn that credential and attach the folder without the user manually copying the password again. Conflicting local credentials fail closed rather than silently replacing existing data.

### 4. Encrypted local storage and offline use

Syncpeer separates **app-owned private storage** from ordinary user-selected Syncthing folders.

Syncpeer-managed private storage is protected by a master-password-derived vault and versioned format checks. Remembered unlock material is stored through the operating system's protected secret store.

Favorite folders can keep encrypted local replicas and directory snapshots so previously selected content remains useful while the peer is offline.

A normal Syncthing-compatible folder that the user deliberately attaches as a plaintext filesystem folder remains plaintext by design. Syncpeer does not pretend that ordinary external folders are encrypted when they are not.

### 5. Recovery

Recovery is split deliberately:

- a **personal-space backup** contains the encrypted information needed to restore the space,
- a separate **offline recovery kit** carries the recovery signing capability.

The private recovery signing key is not stored in the ordinary device vault and is not embedded in the portable backup. Requiring both pieces prevents a copied backup alone from silently becoming a new trusted device.

The recovery flow can enroll a replacement device and revoke devices represented by the recovered membership state.

### 6. Android architecture

On Android, the foreground UI is not the sole owner of synchronization.

A background service owns incoming synchronization and the persistent document runtime. This lets Syncpeer continue serving and receiving synchronized content when the Activity is recreated.

Android also exposes Syncpeer documents through a DocumentsProvider, allowing compatible system file pickers and editors to work with synchronized content without requiring the main Activity to stay open.

Background execution remains subject to Android power/network constraints; Syncpeer does not promise impossible always-on execution.

## Security and storage boundaries

A few boundaries are important:

- Syncthing/BEP interoperability does not mean every folder is automatically encrypted at rest.
- Syncpeer's private vault, personal-space settings, remembered secrets, and Syncpeer-managed encrypted replicas have their own protection rules.
- User-selected normal Syncthing folders remain normal filesystem folders unless explicitly handled as an encrypted Syncpeer replica.
- Device pairing requires explicit matching-code confirmation.
- Unknown devices are not silently added to the personal space.
- Revoked owned devices are excluded from personal-space sharing.
- Recovery requires the appropriate backup and recovery material.
- Tests and diagnostics are designed not to reuse real-world peer IDs, keys, or endpoints as fixtures.

See `SYSTEM_DEFINITION.csv` for the exact current requirement and evidence for each boundary.

## Releases

GitHub releases are published from version tags. The release workflow builds an
AppImage, Flatpak, signed Android APK, CI-generated screenshots, and SHA-256 checksums:

- Releases: <https://github.com/yeus/syncpeer/releases>
- Latest stable release: <https://github.com/yeus/syncpeer/releases/latest>

Release candidates such as `v0.6.0-rc.1` are published as GitHub pre-releases.

An RC is intentionally the boundary between automated acceptance and real-world
validation. Before an RC is cut, all feasible local, CI, emulator, synthetic,
packaged, and explicitly configured external acceptance gates for that scope
should be green. The RC phase is then used for physical-device, real-network,
install/upgrade, lifecycle, interoperability, and ordinary user testing before
the stable release.

## Screenshots

The screenshots below are generated automatically from the packaged Tauri
acceptance flow. They are **not stored in this repository**. On ordinary
push/PR CI runs they are uploaded only as seven-day GitHub Actions preview
artifacts. On a tagged release, the same PNGs are attached to that GitHub
Release and remain available for as long as the release itself exists.
<p align="center">
  <img src="https://github.com/yeus/syncpeer/releases/download/v0.6.0-rc.1/syncpeer-personal-space.png" width="32%" alt="Syncpeer personal-space trusted-device membership">
  <img src="https://github.com/yeus/syncpeer/releases/download/v0.6.0-rc.1/syncpeer-encrypted-folder.png" width="32%" alt="Syncpeer encrypted folder setup">
  <img src="https://github.com/yeus/syncpeer/releases/download/v0.6.0-rc.1/syncpeer-sync.png" width="32%" alt="Syncpeer bidirectional synchronized folder">
</p>

## Quick start for developers

Install dependencies and build:

```bash
npm install
npm run build
```

CLI help:

```bash
node dist/cli/main.js --help
```

Run the desktop development app:

```bash
npm run dev
```

Run the main headless and E2E suites:

```bash
npm run test:headless
npm run test:e2e
```

Run the combined Android validation workflow:

```bash
npm run test:android
```

The live public discovery/relay acceptance test is deliberately opt-in because it contacts public Syncthing infrastructure:

```bash
SYNCPEER_RUN_EXTERNAL_CHECKS=1 npm run test:public-network
```

More build, test, packaging, Android, signing, LAN, and release instructions are in
[`DEVELOPMENT.md`](./DEVELOPMENT.md).

## Repository structure

- `packages/core` — framework-free protocol, synchronization, personal-space, storage, and domain logic
- `packages/cli` — command-line shell over core
- `packages/app` — Svelte UI used by desktop and Android
- `packages/tauri-shell` — desktop/Android native host and transport/storage adapters
- `scripts` — builds, diagnostics, fixtures, release tooling, and acceptance harnesses
- `SYSTEM_DEFINITION.csv` — canonical requirement/implementation/verification catalog

The architecture rule is simple: shared product logic belongs in core; UIs and native shells should remain thin adapters.

## Development principles

The project favors:

- explicit state transitions over hidden watcher behavior,
- small and testable core functions,
- immutable data flow where practical,
- side effects at platform boundaries,
- deterministic recovery and retry behavior,
- root-cause fixes instead of longer timeouts,
- real workload regressions in addition to happy-path unit tests.

See [`development_instructions.md`](./development_instructions.md) and
[`DEVELOPMENT.md`](./DEVELOPMENT.md).

## Experimental and incomplete areas

Syncpeer is still an evolving pre-1.0 client, and not every implemented path has
the same acceptance level.

- Direct TCP and standard relay transport are the primary v0.6 packaged paths.
  A direct QUIC path exists, but packaged QUIC validation remains follow-up work.
- Contacts/calendar PIM support exists behind an explicit experimental gate and
  should not be treated as a default synchronization feature yet.
- Physical-device, true power-loss, broader NAT/firewall, installation/upgrade,
  and longer ordinary-use validation belong to the RC phase.
- Full Syncthing protocol coverage is not a goal that is already complete.

The current implementation has substantial real synchronization,
encrypted-storage, personal-space, relay, desktop, and Android coverage. The
canonical status and evidence for each requirement remains
`SYSTEM_DEFINITION.csv`.

## License

Syncpeer's original source code is licensed under the MIT License. Vendored
third-party files retain their respective licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
