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
npm run build:tauri:bundle:flatpak
```

AppImage builds use a fresh temporary Cargo/AppDir staging tree and remove it
after the build. Only the final AppImage is copied into the Tauri bundle
directory and `dist/`, so read-only Nix store files are not left in Cargo's
normal target directory.

The Flatpak build uses the GNOME 50 runtime and SDK. In the Nix development
shell, the `flatpak` and `flatpak-builder` tools are available. The build
command automatically adds a user-level Flathub remote when needed and asks
`flatpak-builder` to install the runtime, SDK, and SDK extensions without
requiring `sudo`.

The resulting bundle is copied to `dist/Syncpeer_<version>_<arch>.flatpak`.

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

## Diagnostics and E2E Test Suites

The repository has two test umbrellas:

```bash
npm run test:diagnostics
npm run test:e2e
```

`test:diagnostics` runs the headless core/protocol checks, local Syncthing
integration, CLI checks, PIM checks, approval checks, discovery checks, the
NixOS firewall helper checks, and the native Tauri packet checks. It also runs
the remote CLI and Syncthing REST checks when the corresponding external
server/API is configured. Optional external checks are reported as skipped,
never silently omitted. Its report is written to
`.tmp/syncpeer-test-reports/diagnostics-report.json`.

`test:e2e` runs the local Tauri workflows and, when a saved or configured
development server ID is available, the remote Tauri UI workflows. The remote
UI workflow includes a test that opens the app's Diagnostics page and runs all
diagnostics through the real UI. Set
`SYNCPEER_RUN_TWO_COMPUTER_E2E=1` to add the two-host LAN/internet harness.
Its report is written to `.tmp/syncpeer-test-reports/e2e-report.json`.

The local diagnostics harness creates isolated Syncthing homes, so it does
not use or modify a running development server. Preserve those temporary
homes for debugging with:

```bash
SYNCPEER_DIAGNOSTICS_KEEP=1 \
  npm run test:diagnostics
```

The two suites are the supported test entry points. The long-running server
and client commands below are operational harness controls, not additional
test suites.

## Local Syncthing Integration Harness

Download pinned Syncthing binary:

```bash
npm run download:syncthing
```

Run all headless diagnostics, including the local automated integration
harness:

```bash
npm run test:diagnostics
```

## Long-Running Development Test Server

For iterative development against a real Syncthing peer, start the persistent
fixture server on one computer:

```bash
npm run test:server
```

The server immediately starts Syncthing, prints its stable device ID and local
Web UI address, and then waits for pending clients. It uses official global
discovery with the standard Syncthing relay fallback, so relay traffic does not
require an inbound firewall rule or the test coordinator. Its identity,
approved clients, fixture folders, and logs persist under
`.tmp/syncpeer-dev-server/` across restarts.

On the development computer, run:

```bash
npm run test:client
```

Enter the printed server device ID on the first run. The client remembers it
under `.tmp/syncpeer-dev-client/` and prints its own persistent device ID while
attempting a normal Syncthing connection. The server terminal then shows the
pending ID. Compare it with the client output and enter `y` to approve it as a
trusted fixture client. Enter `u` only for a receive-encrypted test identity.
Unknown devices are never accepted automatically.

After approval, the client reconnects, browses the fixture, downloads and
verifies `hello.txt`, and uploads a test file. The server remains running for
later client builds until Ctrl-C. The Syncthing Web UI is optional and remains
bound to localhost.

To run the Tauri workflows against the same long-running server, keep the
server running and use one command on the client computer:

```bash
export SYNCPEER_DEV_SERVER_DEVICE_ID=...
export SYNCPEER_DEV_CLIENT_CONFIG_HOME=.tmp/syncpeer-e2e-new
npm run test:e2e
```

The local Tauri workflow is self-contained. The remote Tauri workflow checks
native discovery and relay commands, connection controls, reconnects, folder
browsing, cache downloads, a large download, an upload workflow, and the
complete in-app diagnostics catalog.

The self-contained workflow skips the LAN-discovery case because its fixture
server and client share one network namespace and therefore cannot both bind
Syncthing's fixed UDP discovery port. The two-host E2E workflow runs that case.

The approved client identity must be selected with
`SYNCPEER_DEV_CLIENT_CONFIG_HOME` when it is not the default CLI identity. The
remote CLI diagnostics, when enabled, write their detailed report to
`.tmp/syncpeer-dev-client/diagnostics/`. The long-running server remains a
separate process and is never started or stopped by either umbrella.

The shared diagnostics runner follows Taskyon's registry, metadata, progress,
timeout, structured-result, and abort conventions so the same diagnostics can
later be reused by a Taskyon Syncthing storage backend.

## Two-Computer LAN Harness

This harness runs a real Tauri Syncpeer client against an isolated Syncthing
fixture on another computer. Enter the flake development shell on both
computers first; it provides the GTK/WebKit runtime and `xvfb-run`. The local
E2E umbrella uses `xvfb-run` for a deterministic Tauri display.

Keep both checkouts on compatible LAN protocol versions. They do not
need to use the same Git commit: the server checkout defines the Syncthing
fixture and test configuration, while the client checkout contains the
Syncpeer implementation under test. For automatic two-host mode, run the
E2E umbrella on both computers:

```bash
SYNCPEER_RUN_TWO_COMPUTER_E2E=1 \
  npm run test:e2e
```

Multicast discovery pairs the two processes and chooses one computer as the
Syncthing fixture server. The other builds the test-only Tauri binary and runs
the WebdriverIO suite. The coordinator and Syncthing fixture stay on the
fixture computer; the client receives fixture metadata and sends phase, action,
and result requests over the LAN. The data connection itself is a normal
Syncthing connection.

Each process keeps announcing and listening for up to 60 seconds when the
other process has not started yet, then settles for 2 seconds after finding a
compatible peer.

Use `SYNCPEER_LAN_PAIR=my-pair` when more than one pair is being tested on
the same network. The local equivalent is included in `npm run test:e2e`.
Set `SYNCPEER_E2E_KEEP=1` when preserving isolated Syncthing homes and logs
under `.tmp/syncpeer-lan/` is needed.

For a deliberate server-first run, use explicit roles. The server prints its
random Syncthing device ID; enter it at the client prompt. The client prints
its test identity and asks you to copy the Tauri app's `This Device` ID back to
the server prompt. The server then adds those IDs to its Syncthing config.
On the same LAN, no address variables are required:

On the server:

```bash
npm run test:lan:server
```

On the client:

```bash
npm run test:lan:client
```

On NixOS, the firewall-enabled variants temporarily open the ports needed by
the test and restore the declarative firewall configuration when the process
exits:

On the server:

```bash
npm run test:lan:server:firewall
```

On the client:

```bash
npm run test:lan:client:firewall
```

The server opens TCP `38378` for the coordinator, UDP `38377` for Syncpeer
role discovery, UDP `21027` for Syncthing LAN discovery, and the dynamically
allocated Syncthing data port. The client opens the two UDP discovery ports.
This uses `nixos-firewall-tool`; it requires suitable `sudo` access. Cleanup
uses its `reset` operation, so do not use this mode while you have other
manually added runtime firewall rules that must be preserved.

On the same LAN, multicast discovery finds the server automatically. For a
remote run, set `SYNCPEER_LAN_HOST` on the server and
`SYNCPEER_LAN_PEER` on the client as address overrides.

The test exercises direct TCP, Syncthing LAN discovery, official global
discovery, and the standard Syncthing relay pool. Global discovery uses
`https://discovery.syncthing.net/v2/`; the server and client device IDs are
generated per run and are never hard-coded.

For an internet/NAT run, the coordinator port (`38378` by default) still needs
to be reachable at `SYNCPEER_LAN_HOST`; Syncthing's device traffic can then
use global discovery, NAT traversal, or the relay pool.

The Tauri suite uses the embedded WebDriver by default. On Linux, if the
installed WebKitGTK runtime reports an unsupported JavaScript result, retry the
client with the external driver:

```bash
SYNCPEER_LAN_DRIVER=external \
  SYNCPEER_RUN_TWO_COMPUTER_E2E=1 \
  npm run test:e2e
```

That fallback installs `tauri-driver` through Cargo when needed and uses the
WebKitWebDriver supplied by the flake.

## CLI Quick Examples

```bash
npx tsx src/cli/main.ts --remote-id <device-id> list
npx tsx src/cli/main.ts --remote-id <device-id> tree <folder-id>
npx tsx src/cli/main.ts --remote-id <device-id> files <folder-id> [dir]
npx tsx src/cli/main.ts --remote-id <device-id> download <folder-id> some/file.txt ./out.txt
```

If `--cert`/`--key` are omitted, syncpeer uses persisted identity at:

- `~/.config/syncpeer/cli-node`
- or `$XDG_CONFIG_HOME/syncpeer/cli-node`
