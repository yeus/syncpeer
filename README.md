# syncpeer

Minimal read-only Syncthing BEP client in TypeScript.

## What is included

- TLS connection using Syncthing-compatible cert/key pairs
- BEP Hello framing
- Post-auth BEP frame parsing
- Remote folder listing
- Tree view of indexed files
- File download by path
- Persisted local `cli-node` identity (`~/.config/syncpeer/cli-node`)
- Local Syncthing test harness

## Quick start

```bash
npm install
npm run build
node dist/cli/main.js --help
```

## Local test setup

Download a pinned Syncthing binary:

```bash
npm run download:syncthing
```

Start two isolated local Syncthing instances and prepare a shared test folder:

```bash
npm run test:local
```

This is fully automated (no GUI steps). It:

- creates two Syncthing homes
- configures peers + shared folder
- waits for sync to complete
- runs the TypeScript BEP client check against the second instance

Use `npm run test:local:keep` to keep processes and temp files for debugging.

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

If `--cert`/`--key` are omitted, `syncpeer` uses a persisted local identity at `~/.config/syncpeer/cli-node` (or `$XDG_CONFIG_HOME/syncpeer/cli-node`).

## Notes

This is intentionally minimal. It does not implement full sync logic, uploads, or REST API usage.
