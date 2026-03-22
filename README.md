# syncpeer

This project aims to provide a minimal, read‑only client for [Syncthing](https://syncthing.net) using its Block Exchange Protocol (BEP) directly.

## Overview

`syncpeer` connects to a single Syncthing peer over TLS, authenticates using a device certificate, receives the remote index, prints a tree of files and allows downloading individual files.  It deliberately does **not** use the REST API or `libp2p`, and implements only the subset of BEP necessary to read data.

### Features

* Connect to a Syncthing peer via TCP/TLS using a device certificate.
* Perform the BEP handshake (Hello and ClusterConfig messages).
* Receive and parse remote `Index` messages to build an in‑memory file system representation.
* Expose a `RemoteFs` interface with `listFolders`, `readDir`, `stat` and `readFileRange` methods.
* Provide a CLI with commands to list folders, display a directory tree and download a file.

### Non‑Goals

* No support for uploads or full bidirectional synchronisation.
* Only a single peer can be connected at a time.
* Compression is disabled by default; the client requests uncompressed metadata to avoid an additional LZ4 dependency.

### Usage

After installing dependencies (see `package.json`) you can run the CLI via `ts-node`:

```
cd syncpeer
npm install
npx tsx src/cli/main.ts --help
```

You will need a Syncthing device certificate and key (the same files Syncthing uses) and the device ID of the peer you wish to connect to.  The commands accept options to specify these values.

For example, to list folders on a remote device running on `192.168.1.10:22000`:

```
npx tsx src/cli/main.ts --host 192.168.1.10 --port 22000 --cert path/to/device.pem --key path/to/key.pem --remote-id ABCD-EFGH-IJKL-MNOP list
```

See `src/cli/commands` for details on each command.

## Project structure

```
syncpeer/
├── package.json        # dependencies and scripts
├── tsconfig.json       # TypeScript configuration
├── src
│   ├── client.ts       # high‑level client using RemoteFs
│   ├── core
│   │   ├── transport    # TLS transport implementation
│   │   │   └── node.ts
│   │   ├── protocol
│   │   │   ├── bep.ts   # message definitions and helpers (generated from .proto)
│   │   │   └── index.ts
│   │   └── model
│   │       └── remoteFs.ts
│   └── cli
│       ├── main.ts      # CLI entry point
│       └── commands
│           ├── list.ts
│           ├── tree.ts
│           └── download.ts
└── README.md
```

## Implementation notes

This implementation uses [`protobufjs`](https://github.com/protobufjs/protobuf.js) to parse the BEP `.proto` definitions at runtime.  The protocol schema is embedded in `src/core/protocol/bep.ts` and compiled on startup.  You can regenerate static types if desired by running the `generate` script defined in `package.json` (requires the `pbjs` and `pbts` CLI tools).

The core logic intentionally avoids Node‑specific APIs outside of the `node.ts` transport adapter.  All message framing, parsing and encoding takes place in the `protocol` layer, making it possible to add WebSocket or WebTransport based transports in the future.
