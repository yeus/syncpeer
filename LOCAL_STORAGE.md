# Syncpeer local storage and encryption

This document describes the storage layout implemented today. It distinguishes
cryptographic encryption from merely storing data in an application-private
directory. The latter protects against casual access by other applications, but
it is not a substitute for encryption against someone who can read the device.

## The short answer

There is one document-replica root per registered folder. A folder registration
contains a `storageId`; that ID selects one local storage root and one folder
encryption key. The profile root is separate and is shared by all registrations
for the vault and folder registry.

The native document replica is currently an app-owned local representation of a
logical Syncthing folder; it is not necessarily the user's selected filesystem
directory. The separate Node/CLI two-way adapter is the path that directly uses
a selected directory.

The current native document path encrypts the downloaded document bytes,
logical file names, file metadata, private indexes, baselines, directory
snapshots, cache access records, and temporary encrypted edits. It does not
make every local byte confidential, however:

- `.stfolder` is an intentionally visible Syncthing compatibility marker.
- Native SQLite still exposes record names, sizes, revisions, timestamps, and
  some system identities. Sensitive record values are encrypted before the
  adapter stores them, but SQLite itself is not an encrypted database.
- The folder registry and the keyless ciphertext-history index currently store
  structured metadata without a folder-key encryption wrapper.
- Legacy UI state, the legacy download cache, Android SAF exports, and the
  default identity key are currently file/app-storage protected rather than
  cryptographically encrypted.
- A standalone Node two-way folder is intentionally a normal plaintext folder
  for Syncthing compatibility. It is not the same implementation as the
  encrypted document replica.

Therefore, “the local replica is encrypted” is true for the encrypted document
content path, but it is not true for every storage path in the application.

## Native document storage (Tauri desktop and Android service)

The following is a logical tree. `<app-data>` and `<noBackupFilesDir>` are
platform-owned application directories, and `<storageId>` is a random 32-hex
identifier. The desktop and Android roots have the same core layout even though
their platform prefixes differ.

```text
<app-private-data>/
├── syncpeer/
│   ├── profiles/documents/
│   │   ├── profile/                         shared profile root
│   │   │   ├── .stfolder                    visible compatibility marker
│   │   │   └── .syncpeer-space              password-wrapped personal-space root key (new profiles)
│   │   └── <storageId>/                     one root for one folder
│   │       ├── .stfolder                    visible compatibility marker
│   │       ├── <encrypted filename>/        encrypted document file
│   │       ├── .stversions/<version-id>/    encrypted archived documents
│   │       ├── .syncpeer-draft-<random>/    encrypted interrupted edit
│   │       └── .syncpeer-scratch-<random>/  encrypted temporary blocks
│   ├── favorites.json                       legacy UI favorites (plaintext)
│   ├── settings.json                        legacy app settings (plaintext)
│   └── cli-node/
│       ├── cert.pem                          public certificate
│       └── key.pem                            private key (not encrypted today)
└── metadata/
    └── folders/<sha256(root-path)>/
        ├── metadata.sqlite3                 durable metadata database
        ├── metadata.sqlite3-wal             SQLite write-ahead log
        ├── metadata.sqlite3-shm             SQLite shared-memory sidecar
        ├── initialized                      initialization sentinel
        ├── operation.lock                   temporary single-writer lock
        └── backups/metadata-<timestamp>.sqlite3
```

On Android, the concrete roots are currently:

```text
<noBackupFilesDir>/documents/profile/
<noBackupFilesDir>/documents/<storageId>/
<noBackupFilesDir>/metadata/folders/<sha256(root-path)>/metadata.sqlite3
```

`noBackupFilesDir` is app-private and excluded from Android automatic backup;
that fact alone does not encrypt its contents. The desktop uses the Tauri app
data directory for `syncpeer/profiles` and its app data `metadata` directory.

The native adapter receives a list of private record prefixes from core. Those
records are normally not materialized as files in the document root; they are
stored as rows in the external SQLite database instead. The tree below lists
the logical records and their current protection.

### Profile-root records (shared by all folders)

```text
profile root
├── .syncpeer-vault-record
├── .syncpeer-space                 new profiles only; stored as a separate app-private file
└── .syncpeer-document-folders
```

- `.syncpeer-vault-record` is an unencrypted outer record containing format,
  lock/remember flags, and an encrypted payload. The payload contains folder
  passwords, connection passwords, and profile settings. New format-2 profiles
  encrypt it using a vault key derived from a random personal-space root key;
  legacy format-1 profiles use a master-password-derived key.
- `.syncpeer-space` is a bounded recovery record for new profiles. Its readable
  header contains only the format, a fresh random salt, KDF identifier, and
  nonce. Its authenticated ciphertext contains the random personal-space ID,
  the distinct Syncthing settings-folder ID, and the random root key. Changing
  the master password rewraps this record without re-encrypting the vault.
  It is currently local; owned-device synchronization is not implemented yet.
  Core can also make a separate encrypted offline backup of this space key and
  the current vault snapshot using a distinct recovery password. This is not
  yet exposed as a supported file-export/import workflow, and it does not
  contain downloaded document bytes or device identity keys.
- `.syncpeer-document-folders` currently contains JSON registration metadata
  such as folder IDs, labels, storage IDs, and download-mode flags. It is kept
  in app-private SQLite storage, but the JSON is not currently wrapped with a
  folder/vault encryption record.

### Per-folder records

```text
<storageId> logical private records
├── .syncpeer-replica-index       encrypted with that folder's key
├── .syncpeer-baseline-<hash>     encrypted with that folder's key
├── .syncpeer-directory-catalog   encrypted with that folder's key
├── .syncpeer-cache-access        encrypted with that folder's key
├── .syncpeer-draft-*/head        encrypted with that folder's key
└── .syncpeer-scratch-*/*         encrypted with an ephemeral scratch key
```

The encrypted file envelope protects both document bytes and the logical file
metadata carried in the authenticated trailer. Physical names are ciphertext
names, so the local root does not normally expose the user's document paths.
Version IDs contain a timestamp and random suffix; they reveal version timing
and count, but not document contents.

The practical protection summary is:

| Local item | Current protection | What can still be visible |
| --- | --- | --- |
| Downloaded document and encrypted archive bytes | Folder-key encryption and authenticated integrity | File size, encrypted filename shape, version timing/count |
| Replica index, baselines, directory catalog, cache-access record | Folder-key encryption | SQLite row structure and record bookkeeping |
| Vault payload (folder/connection passwords and profile settings) | New profiles: random root-derived vault key; legacy profiles: master-password/remembered-secret key | Outer format, `manualLocked`, and `remember` flags |
| Personal-space bootstrap | Master-password-wrapped random root key | KDF parameters and ciphertext length; neither space nor folder ID is readable |
| Folder registry | App-private storage only; JSON is not wrapped today | Folder IDs, labels, storage IDs, and download flags |
| Keyless ciphertext index | Ciphertext descriptors and integrity checks, but no folder-key wrapper | Folder identity/token material and journal structure |
| `.stfolder` | Deliberately plaintext marker | Marker existence and filesystem identity |
| Legacy cache, WebView state, identity key | Plaintext/application permissions today | Their complete contents to a local reader |

The optional keyless ciphertext-history path is different:

```text
keyless ciphertext-history root
├── .syncpeer-ciphertext-index
└── .syncpeer-ciphertext-generations/<content-hash>
```

The generations and their trailers are ciphertext and can be retained while
the folder is locked. The index is currently a structured JSON journal that
contains encrypted descriptors plus folder identity/password-token material;
it is not itself wrapped with a folder key. This is deliberate for locked
history forwarding, but it leaves structural metadata visible and is a
remaining hardening task.

### What SQLite does and does not encrypt

SQLite is the durable storage mechanism, not the cryptographic boundary. Core
serializes and encrypts sensitive records before passing bytes to the native
adapter. The adapter stores opaque bytes and does not know any keys. SQLite
still necessarily exposes database structure such as record IDs, row lengths,
revision counters, modification times, the root identity, and marker identity.
Backups contain the same information and must be protected like the live
database.

## Android protected unlock material

The document vault does not store the master password as plaintext. For new
personal-space profiles, remembered unlock stores the master password in a
file encrypted with an AES-GCM key held by Android Keystore. Older device-only
vaults instead store their generated unlock secret there:

```text
<noBackupFilesDir>/
├── syncpeer.vault.documents.secret          AES-GCM ciphertext
└── syncpeer.vault.background-session.secret AES-GCM ciphertext

<app-private SharedPreferences>/
├── syncpeer-vault-policy.xml                 biometric-enabled flag
└── document-runtime.xml                      device counter
```

The Keystore key is not exportable through the app. The preference values are
small control values, not the vault contents. Linux desktop remembered unlock
uses the OS Secret Service instead of a file under the tree.

## Legacy cache and UI state

These paths remain for compatibility with the older download/cache adapter and
are not the encrypted document replica:

```text
<app-cache>/syncpeer/files/
├── <folder-id>/<safe-path>                  downloaded bytes (plaintext today)
└── .partial/
    ├── <transfer-id>.part                   partial bytes (plaintext today)
    └── <transfer-id>.json                   transfer metadata (plaintext)

<WebView localStorage>
└── syncpeer.ui.state.v1                     UI state (plaintext)
```

The WebView state can contain connection details, saved devices, offline
directory snapshots, UI preferences, and—when secure folder storage is not
available—a fallback copy of folder passwords. It can also contain inline PEM
values if a user entered them instead of file paths. That fallback and the
legacy cache are security gaps, not an intended long-term storage design.

On Android, an explicitly selected Storage Access Framework (SAF) directory is
outside the app-private area. Files exported there are ordinary files; Syncpeer
does not silently encrypt that user-owned export location.

PIM paths such as `syncpeer/pim/...` are synchronized folder content, not a
separate local database. If a PIM file is downloaded into a native document
replica it receives the same folder encryption as any other file. If it is
exported through the legacy cache or SAF, the export follows those plaintext
rules instead.

## Standalone Node/CLI two-way folder

The CLI's `createNodeFolderReplica` path is the compatibility implementation for
a user-selected folder. It intentionally reads and writes ordinary files so it
can interoperate with Syncthing:

```text
<selected-folder>/
├── .stfolder                         visible Syncthing marker
├── user files                         plaintext by design
├── .stversions/                       plaintext version copies
└── .syncpeer-trash/                   plaintext trash copies

<state-root>/folders/<sha256(folder)>/
├── metadata.sqlite3                   replica/baseline rows
├── metadata.sqlite3-wal
├── metadata.sqlite3-shm
├── initialized
└── operation.lock
```

The old `.syncpeer-folder-state.json`, `.syncpeer-replica.json`, and
`.syncpeer-replica-settings.json` files are legacy migration inputs. They are
plaintext while present and are removed only after their contents have been
validated and committed to the external SQLite metadata store. The current Node
metadata rows are protected by file permissions and SQLite transactions, not by
application-level encryption.

The CLI identity is separate from folder state:

```text
<config-home>/syncpeer/cli-node/
├── cert.pem                             public certificate
├── key.pem                              private key (not application-encrypted)
└── device-id.txt                        derived device identifier
```

## Runtime-only data

While a vault or folder is unlocked, decrypted keys, file blocks, and parsed
metadata exist in process memory. Core clears keys and temporary buffers when
the owner closes or locks. Network sessions, sockets, pending tasks, and
uncommitted transfer state are also runtime state unless they are explicitly
listed above.

## Target policy and follow-up work

The desired policy is stronger than the current implementation: every sensitive
local record should be encrypted, while `.stfolder` remains the one deliberate
plaintext compatibility marker. The follow-up work is tracked in
`remaining_issues.txt`; it includes encrypting the registry and legacy UI/cache
state, protecting the default identity key, deciding how to hide keyless-index
metadata, and making external SAF output an explicit export boundary.

When inspecting or resetting a local folder, do not treat a missing encrypted
index as an empty folder. Stop the owner, preserve the SQLite metadata and
`.stfolder` identity, and use an explicit migration/recovery operation.
