# syncpeer

Minimal read-only Syncthing BEP client in TypeScript.

## What is included

- TLS connection using Syncthing-compatible cert/key pairs
- BEP Hello framing
- Post-auth BEP frame parsing
- Remote folder listing
- Tree view of indexed files
- File download by path
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

That script prints the exact next steps and the exact CLI commands to run.

## CLI usage

```bash
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/cert.pem list
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/cert.pem tree <folder-id>
npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert path/to/cert.pem --key path/to/cert.pem download <folder-id> some/file.txt ./out.txt
```

## Notes

This is intentionally minimal. It does not implement full sync logic, uploads, or REST API usage.
