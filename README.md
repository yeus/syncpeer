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

## Releases

- Releases page: <https://github.com/yeus/syncpeer/releases>
- Latest release page: <https://github.com/yeus/syncpeer/releases/latest>

## Quick start (users)

```bash
npm install
npm run build
node dist/cli/main.js --help
```

## Development

All contributor/development/build-target documentation lives in:

- [DEVELOPMENT.md](./DEVELOPMENT.md)

## For contributors

- The project deliberately uses TypeScript across core logic and user-facing interfaces.
- The goal is to open protocol/client development to people who may not work primarily in Go or C++.
- Small, focused contributions are welcome.

## Status

This is an evolving prototype. Protocol coverage and sync behavior are not complete yet.
If it remains lightweight while becoming more capable over time, that is the intended path.
