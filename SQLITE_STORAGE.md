# SQLite synchronization metadata

Syncpeer uses SQLite as durable synchronization storage. It is not a disposable
search index: losing it can lose deletion history, causal versions, and recovery
state. Never substitute a new empty database when existing storage is unavailable.

## Platform ownership

- Node/CLI uses `node:sqlite` (Node 22.13 or newer without an experimental flag).
- Tauri uses `rusqlite` with bundled SQLite on desktop and mobile. It does not use
  a separate Android system-SQLite implementation.
- The Android document service calls the same Rust storage owner through its
  existing JNI bridge; the shared TypeScript document core continues to own
  encryption and synchronization decisions.
- Browser persistence is deferred. No SQLite WASM or PGlite runtime is added.

The physical schema is shared in `packages/core/sqlite/metadata.sql`. Records are
keyed by namespace and ID; storage adapters do not interpret encrypted values.
This does not change BEP or add a Taskyon protocol. Future Taskyon integration
should adapt its records/blobs boundary, not share live database files over P2P.

## What is stored

The Node selected-folder adapter stores each replica entry and folder baseline
entry in a separate row, plus snapshot headers, pending publication, pause and
subscription state. Snapshot writes are transactional and skip unchanged values.

The native document adapter stores the core-declared private records (vault,
folder registry, encrypted replica index, directory catalog, per-file baselines,
and cache-access metadata) as opaque SQLite rows. Existing encryption formats
remain owned by core. Native metadata `stat` is an indexed lookup; reads remain
bounded and staged replacement verifies completeness and concurrent changes.

This first migration preserves the core's snapshot-based reconciliation API.
Encrypted replica/catalog records can still contain a complete serialized
snapshot; this is not yet a normalized SQL catalog or a claim of constant-memory
scanning. Node SQLite operations are currently synchronous. Paging, worker
offloading, and large-catalog performance measurements remain follow-up work.

File contents, encrypted drafts/transfer partials, and archived versions remain
files. Existing app preferences and the legacy download-cache index are outside
this synchronization-metadata migration.

## Locations and migration

CLI defaults to the platform's Syncpeer app-state directory; on Linux this is
`$XDG_STATE_HOME/syncpeer` or `~/.local/state/syncpeer`. `SYNCPEER_STATE_DIR` selects
another explicit state root. Library callers may supply `stateRoot`.

Tauri uses an app-owned `metadata` directory. Android's document service uses
`noBackupFilesDir/metadata`, outside its document roots. Each selected root maps
to `folders/<root-path-hash>/metadata.sqlite3`. The external root identity record
detects replacement storage across restarts. A small external `initialized`
sentinel distinguishes a missing database from first initialization.

Selected folders retain the unsynchronized `.stfolder` marker. Existing Syncthing
markers are accepted; legacy Syncpeer markers and metadata are migrated. This
does not authorize running Syncthing and Syncpeer as simultaneous writers to the
same physical folder.

Legacy Node records are validated before import. Native records are copied
byte-for-byte and read back before retiring the originals; core still validates
and decrypts them on use. A disagreement between legacy and committed SQLite
records must stop migration. Missing/corrupt databases and unsupported schema
versions fail visibly. Stop older Syncpeer processes before upgrading; do not
run an old binary against migrated storage.

SQLite uses WAL and FULL synchronous durability. Folder workflows additionally
use an exclusive `operation.lock` in the external metadata directory. A crashed
owner can leave this lock: verify that no writer is running before removing it.
The database transaction protects metadata; existing core journals still handle
the separate commit of actual file bytes.
Different state roots do not share that lock. Concurrent writable frontends
using independently configured stores for the same folder are not supported.

## Backup and validation

The Node metadata adapter exposes `backup(destination)`, using SQLite's consistent
snapshot mechanism. Native storage exposes `backupMetadata()`, creating a snapshot
in its private `backups` directory. Backup files contain private metadata and must
not be committed or published. These are storage primitives, not a new backup UI.

Restore only with all storage owners stopped. Retain the existing state directory
for recovery, and restore the matching database snapshot together with compatible
file contents; restoring metadata alone does not undo changes to documents.
Never copy only a live `.sqlite3` file and omit its WAL.

Tests cover legacy migration, deletion and pause history, pending-publication
recovery, missing/replaced roots, database corruption/version rejection,
transaction rollback on process exit, unchanged-row writes, native bounded reads,
stale/incomplete replacements, and consistent SQLite snapshots. Physical device
crash/reboot and future Windows/macOS/iOS runtime validation remain separate gates.
