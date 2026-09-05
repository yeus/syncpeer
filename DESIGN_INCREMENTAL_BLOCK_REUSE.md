# Incremental Block Reuse for Cached Downloads

Status: proposed and intentionally deferred

## Goal

When a remotely updated file already has a cached local version, reuse unchanged
blocks from that version and download only the changed blocks. This must work
through the same core transfer flow for CLI and Tauri, including encrypted
folders, without passing the complete old file through the Tauri JSON bridge.

## Ownership decision

`packages/core` owns all synchronization policy:

- remote block boundaries and expected hashes;
- comparison of local digests with remote block hashes;
- selection of reusable and missing ranges;
- encrypted-block to plaintext-block mapping;
- request concurrency, checkpoint state, progress, and failure handling;
- the decision to commit or abort the replacement.

Platform adapters own only storage mechanics:

- opening the old cached file and a new partial destination;
- hashing byte ranges requested by core;
- copying ranges selected by core;
- offset-aware writes and atomic replacement;
- platform-specific access such as Android Storage Access Framework operations.

Native code must not choose block sizes, interpret BEP metadata, compare remote
and local block identities, schedule downloads, or implement encryption policy.

## Proposed flow

1. Core receives metadata and the block plan for the new remote version.
2. A new partial destination is opened while the old cached file remains intact.
3. Core asks the storage adapter for digests of the corresponding ranges in the
   old cached file.
4. Core compares those digests with the expected remote hashes.
5. Core instructs the adapter to copy only the verified ranges into the partial
   destination.
6. Core seeds the new download's completed ranges from the copied ranges and
   requests only the missing blocks.
7. The replacement is committed atomically after all ranges are complete and
   verified. Failure leaves the old cached version intact.

The current recovery checkpoint remains responsible for reconnecting during a
download of one unchanged remote version. Reuse across two different versions
is a separate preparation phase and must not weaken the checkpoint's metadata
identity checks.

## Candidate adapter contract

The exact names remain open, but the boundary should resemble:

```ts
interface FileDownloadSink {
  begin(metadata: FileDownloadMetadata): Promise<void>;
  digestCachedRanges?(
    ranges: readonly DownloadRange[],
  ): Promise<readonly RangeDigest[]>;
  copyCachedRanges?(
    ranges: readonly DownloadRange[],
  ): Promise<void>;
  write(offset: number, bytes: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  abort(error: unknown): Promise<void>;
}
```

Digest and copy requests should be batched. Only range descriptions and digests
cross the bridge; cached file contents do not. Implementations may retain opaque
source and destination handles inside the sink.

## Correctness constraints

- Reuse a range only after an exact digest match.
- Do not reuse blocks when trustworthy remote block hashes are unavailable.
- For encrypted folders, compare cached plaintext ranges with the original
  plaintext block hashes; fetching and decryption remain in core.
- Do not modify or remove the old cached file before successful commit.
- Treat changed metadata during preparation or transfer as a new operation.
- Validate adapter results: returned ranges must be requested, in bounds, and
  non-overlapping where the core plan requires that.
- Cancellation or terminal failure aborts only the partial replacement.

## Test strategy

- Core unit tests with a fake storage adapter prove unchanged blocks are copied,
  changed blocks are requested, and adapter output is validated.
- Recovery tests distinguish same-version interrupted downloads from
  cross-version block reuse.
- Encrypted-folder tests prove reuse uses plaintext block identity while missing
  data still follows the encrypted request/decryption path.
- Shared storage conformance tests cover range hashing, copying, bounds,
  cancellation, atomic commit, and cleanup for CLI and Tauri implementations.
- End-to-end tests update a cached/favorite file remotely and verify automatic
  replacement, correct final content, and reduced downloaded bytes.

## Non-goals

- Choosing a new content-defined chunking algorithm. Initial reuse follows the
  block boundaries published by Syncthing.
- Moving BEP or synchronization decisions into Rust or Kotlin.
- Reusing unverified byte ranges.
- Keeping both old and new versions after a successful replacement.
