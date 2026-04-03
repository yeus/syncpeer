# syncpeer

`syncpeer` is an experimental lightweight Syncthing client project.
It is intentionally built in TypeScript to make protocol-level sync tooling more accessible to a broader group of developers.

## Interfaces

- TypeScript library
- CLI
- Desktop app (Svelte + Tauri)
- Android app (Svelte + Tauri)

## Direction

- Partial TypeScript implementation of Syncthing BEP/protocol behavior (in progress).
- Lightweight client focus, inspired by the old [Syncthing Lite](https://github.com/syncthing/syncthing-lite) direction.
- Practical and incremental: keep the surface small, then grow capability carefully.

## Current capabilities

- TLS connection using Syncthing-compatible cert/key pairs
- BEP hello/framing and post-auth frame parsing
- Remote folder listing and indexed-file tree browsing
- File download by path
- Persisted local CLI identity (`~/.config/syncpeer/cli-node`)
- Local automated Syncthing integration harness

## Quick start

```bash
npm install
npm run build
node dist/cli/main.js --help
```

Run the desktop app in dev mode:

```bash
npm run dev
```

Build desktop binaries without Linux package bundling (default):

```bash
npm run build:tauri
```

Build Linux bundles only when explicitly requested:

```bash
npm run build:tauri:bundle:appimage
npm run build:tauri:bundle:deb
```

## Local Syncthing test setup

Download the pinned Syncthing binary:

```bash
npm run download:syncthing
```

Run the local end-to-end harness:

```bash
npm run test:local
```

This flow is automated (no GUI steps): it creates two Syncthing homes, configures peers/shared folder, waits for sync, and runs client checks.

Use `npm run test:local:keep` to keep temporary state for debugging.

## CLI usage

```bash
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/cert.pem list
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/cert.pem tree <folder-id>
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/cert.pem files <folder-id> [dir]
npx tsx src/cli/main.ts files-local /path/to/peer-folder [dir]
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/cert.pem download <folder-id> some/file.txt ./out.txt
npx tsx src/cli/main.ts upload-test /path/to/peer-folder smoke.txt "hello from cli upload test"
npx tsx src/cli/main.ts local-id
```

If `--cert`/`--key` are omitted, `syncpeer` uses the persisted identity at `~/.config/syncpeer/cli-node` (or `$XDG_CONFIG_HOME/syncpeer/cli-node`).

## Android build helpers

- `npm run android:dev`
- `npm run build:android:dev`
- `npm run build:android:prod`

## For contributors

- The project deliberately uses TypeScript across core logic and user-facing interfaces.
- The goal is to open protocol/client development to people who may not work primarily in Go or C++.
- Small, focused contributions are welcome.

## Status

This is an evolving prototype. Protocol coverage and sync behavior are not complete yet.
If it remains lightweight while becoming more capable over time, that is the intended path.
