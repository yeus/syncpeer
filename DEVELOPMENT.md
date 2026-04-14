# Development

This document covers project layout, local development, and build/compile targets.

## Project layout

- `packages/core`: TypeScript Syncthing protocol/client logic (shared by UI + CLI).
- `packages/cli`: Command line interface built on `@syncpeer/core`.
- `packages/app`: Svelte frontend used by the Tauri shell.
- `packages/tauri-shell`: Tauri host (desktop + Android packaging, native commands).
- `scripts`: Helper scripts (Android signing/build helpers, local diagnostics, etc.).
- `dist`: Built artifacts copied to repository-level output paths.

## Prerequisites

- Node.js and npm
- Rust toolchain (for Tauri/native parts)
- Android SDK/NDK + Java toolchain (for Android target builds)

## Install dependencies

```bash
npm install
```

## Build/compile targets

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

Build Tauri shell (desktop, without Linux packaging):

```bash
npm run build:tauri
```

Build desktop Linux bundles (explicitly):

```bash
npm run build:tauri:bundle:appimage
npm run build:tauri:bundle:deb
```

## Run targets (development)

Run desktop app in dev mode:

```bash
npm run dev
```

Run Android dev workflow:

```bash
npm run android:dev
```

## Android build helpers

- `npm run build:android:dev`
- `npm run build:android:prod`
- `npm run build:android:init`
- `npm run android:install:diagnose`
- `npm run icons:generate`
- `npm run icons:ensure:android`

## Local Syncthing integration harness

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

## CLI quick examples

```bash
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/key.pem list
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/key.pem tree <folder-id>
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/key.pem files <folder-id> [dir]
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/key.pem download <folder-id> some/file.txt ./out.txt
```

If `--cert`/`--key` are omitted, syncpeer uses persisted identity at:

- `~/.config/syncpeer/cli-node`
- or `$XDG_CONFIG_HOME/syncpeer/cli-node`
