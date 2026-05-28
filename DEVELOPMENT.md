# Syncpeer Development Philosophy

Syncpeer should be built as a core library with thin shells around it.
Humans and AI agents working in this repository should preserve that shape.

## Core Owns Product Logic

`@syncpeer/core` is the source of truth for protocol behavior, session state,
folder browsing, transfer behavior, PIM data handling, merge policy, and other
domain rules.

If a behavior must be shared by Svelte, CLI, Tauri, Android, tests, or future
frontends, it belongs in core first.

Core code should be framework-free. Use explicit inputs, returned values,
subscriptions, callbacks, and small state transitions instead of depending on
Svelte, Tauri, DOM APIs, or process globals.

## Shells Stay Thin

The Svelte app, CLI, and Tauri commands are shells around core.

They may:

- collect user input
- render state
- call core actions
- adapt platform APIs to core interfaces
- persist user settings and platform-specific data
- report logs and diagnostics

They should not:

- implement Syncthing protocol rules
- infer sync correctness from UI state
- directly own folder browsing state
- perform remote filesystem reads from components
- duplicate core merge, password, discovery, or transfer policy

## State Flow

State transitions should be explicit and testable in core.

For UI flows, prefer this shape:

1. Component dispatches an intent.
2. App action resolves platform/user settings and calls core.
3. Core updates session state.
4. App subscribes to core state and projects it into render state.
5. Component renders the projected state.

Components should not decide when a directory is stale, when to reload a folder,
which password applies to a remote folder, or whether a transfer should retry.

## Directory And Transfer Rules

Directory state belongs in core session state. It should include the selected
folder/path, entries, version key, status, request sequence, and last error.

Downloads and uploads should be modeled as core transfer behavior first. UI
progress indicators should render core transfer state, not implement transfer
logic.

## Passwords And Device Scope

Encrypted folder passwords are scoped by source device and folder ID.

The app may persist passwords, but active password resolution must produce an
explicit device-scoped map for core. Switching source devices while a folder is
open must invalidate or reload the current directory with the new password
context.

## Testing Priorities

Test core behavior before shell behavior.

Prefer focused tests for:

- session state transitions
- directory stale/reload behavior
- password scoping
- transfer retry/progress behavior
- PIM merge and file layout behavior

Shell tests should verify wiring: that UI, CLI, or Tauri adapters call core with
the right inputs and render/report the resulting state.

## Implementation Style

Keep functions small and explicit. Prefer pure helpers for policy and reducers.
Use composition over inheritance. Avoid hidden globals and implicit watchers for
business logic.

When adding a feature, first ask:

> Can this be expressed as core library behavior plus a thin adapter?

If yes, implement it that way.

## Project Layout

- `packages/core`: framework-free Syncthing protocol, session, PIM, and shared domain logic
- `packages/cli`: command line shell over `@syncpeer/core`
- `packages/app`: Svelte frontend used by the Tauri shell
- `packages/tauri-shell`: Tauri host for desktop and Android native commands
- `scripts`: helper scripts for Android builds, diagnostics, and local testing
- `dist`: built artifacts copied to repository-level output paths

## Prerequisites

- Node.js and npm
- Rust toolchain for Tauri/native parts
- Android SDK/NDK and Java toolchain for Android builds

## Install Dependencies

```bash
npm install
```

## Build And Compile Targets

Build everything:

```bash
npm run build
```

Build CLI only:

```bash
npm run build:cli
```

Build app frontend only:

```bash
npm run build:app
```

Build Tauri shell without Linux packaging:

```bash
npm run build:tauri
```

Build desktop Linux bundles explicitly:

```bash
npm run build:tauri:bundle:appimage
npm run build:tauri:bundle:deb
```

## Development Run Targets

Run desktop app in dev mode:

```bash
npm run dev
```

Run Android dev workflow:

```bash
npm run android:dev
```

## Android Build Helpers

- `npm run build:android:dev`
- `npm run build:android:prod`
- `npm run build:android:init`
- `npm run android:install:diagnose`
- `npm run icons:generate`
- `npm run icons:ensure:android`

## Local Syncthing Integration Harness

Download pinned Syncthing binary:

```bash
npm run download:syncthing
```

Run local automated integration harness:

```bash
npm run test:local
```

Keep temporary test state for debugging:

```bash
npm run test:local:keep
```

## CLI Quick Examples

```bash
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/key.pem list
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/key.pem tree <folder-id>
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/key.pem files <folder-id> [dir]
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/key.pem download <folder-id> some/file.txt ./out.txt
```

If `--cert`/`--key` are omitted, syncpeer uses persisted identity at:

- `~/.config/syncpeer/cli-node`
- or `$XDG_CONFIG_HOME/syncpeer/cli-node`
