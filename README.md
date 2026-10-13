<p align="center">
  <img src="icon.svg" width="80" height="80" alt="Syncpeer icon">
</p>

<h1 align="center">Syncpeer</h1>

<p align="center">Syncthing-compatible file sync for desktop, Android, and TypeScript.</p>

<p align="center">
  <a href="https://github.com/yeus/syncpeer/releases/latest"><strong>Download desktop &amp; Android</strong></a>
  · <a href="DEVELOPMENT.md"><strong>Build from source</strong></a>
  · <a href="SYSTEM_DEFINITION.csv"><strong>System status</strong></a>
  · <a href="https://github.com/yeus/syncpeer">GitHub project</a>
</p>

Syncpeer is a local-first, open-source client with a shared TypeScript core for
Linux desktop, Android, the command line, and TypeScript applications.

> **Early release:** Syncpeer is pre-1.0 and does not implement every Syncthing
> feature. Support and validation vary by feature and platform; see the
> [system definition](SYSTEM_DEFINITION.csv) for current evidence and limits.

## What you can do

- **Sync with Syncthing peers.** Syncpeer uses Syncthing-compatible device
  identities, TLS, and BEP, with standard LAN/global discovery and relay
  infrastructure.
- **Browse and keep files available offline.** Explore remote folders, sync
  selected content, and use encrypted Syncpeer-managed replicas while peers are
  away.
- **Connect your own devices.** Pair with a matching confirmation code, manage
  signed device membership, and share approved folder credentials and settings.
- **Use the same core in different shells.** The TypeScript library powers the
  CLI, desktop and Android apps, and application integrations.

## Privacy and storage

Syncpeer has no central account or file-storage service. Standard Syncthing
relays can forward encrypted traffic but may observe connection metadata.

Syncpeer-managed private storage and encrypted replicas have their own
protection rules. A normal Syncthing folder that you attach remains a regular
filesystem folder and is **not encrypted at rest by Syncpeer**. Device pairing
requires explicit confirmation; recovery uses a personal-space backup and a
separate offline recovery kit.

## Screenshots

These previews come from the packaged desktop acceptance flow. CI uploads them
as short-lived artifacts; tagged releases keep them with the release. The PNGs
are generated and are not stored in the repository.

<p align="center">
  <img src="https://github.com/yeus/syncpeer/releases/latest/download/syncpeer-personal-space.png" width="32%" alt="Syncpeer personal-space trusted-device membership">
  <img src="https://github.com/yeus/syncpeer/releases/latest/download/syncpeer-encrypted-folder.png" width="32%" alt="Syncpeer encrypted folder setup">
  <img src="https://github.com/yeus/syncpeer/releases/latest/download/syncpeer-sync.png" width="32%" alt="Syncpeer bidirectional synchronized folder">
</p>

## Get started

Download Linux desktop or Android builds from the
[latest release](https://github.com/yeus/syncpeer/releases/latest). To build
from source, install dependencies and compile:

```bash
npm install
npm run build
```

For development, testing, packaging, Android setup, and release steps, see the
[development guide](DEVELOPMENT.md). The system catalog links each tracked
feature to its implementation, verification, and known limitations.

## License

Syncpeer's original code is [MIT licensed](LICENSE). Vendored software retains
its own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
