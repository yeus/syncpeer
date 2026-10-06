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
node dist/cli/main.js --help
```

## Development

All contributor/development/build-target documentation lives in:

- [DEVELOPMENT.md](./DEVELOPMENT.md)
- [SYSTEM_DEFINITION.csv](./SYSTEM_DEFINITION.csv) - the canonical system definition and agent
  guardrail: product behavior, architecture, requirements, status, Syncthing-compatibility layer,
  implementation evidence, validation, milestones and known limitations

The planning documents that previously lived in this repository (roadmap,
remaining issues, local-storage map, SQLite storage notes and the incremental
block-reuse design) have been folded into `SYSTEM_DEFINITION.csv` and removed. Their
texts remain available in Git history.

## For contributors

- The project deliberately uses TypeScript across core logic and user-facing interfaces.
- The goal is to open protocol/client development to people who may not work primarily in Go or C++.
- Small, focused contributions are welcome.

## Status

This is an evolving prototype. Protocol coverage and sync behavior are not complete yet.
If it remains lightweight while becoming more capable over time, that is the intended path.

## License

Syncpeer's original source code is licensed under the MIT License. Vendored
third-party files retain their respective licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
