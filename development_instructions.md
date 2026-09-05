# Development Instructions

This project should prefer explicit, minimal, functional-style architecture.

## Core Principles

- Explicit is better than implicit.
- Prefer pure functions and immutable data flow where practical.
- Keep side effects at boundaries (I/O, network, filesystem, UI adapters).
- Composition over inheritance.
- One function, one purpose.
- Keep functions small (rough target: ~40 lines max when possible).
- Avoid global mutable state.
- Avoid hidden behavior triggered by implicit watchers or background loops.
- Prefer event-driven transitions over polling-driven magic.
- Keep code readable and straightforward; avoid unnecessary abstraction layers.
- Avoid duplicated logic; maintain a single source of truth.

## Architecture Boundaries

- `packages/core` is the domain/library layer and must contain the real logic.
- UI layers (`packages/app` Svelte/Tauri) should be thin render/action shells.
- CLI should call into core logic, not re-implement behavior.
- Platform-specific APIs must be wrapped behind adapters.
- Session and protocol state transitions must be explicit and testable.

## Reactivity and State

- UI should render state, not derive core logic.
- Important updates should be emitted as explicit state transitions/events.
- Do not rely on implicit reactivity/watchers to “eventually” fix stale state.
- Prefer deterministic state machines for async workflows:
  - example: `idle -> loading -> ready -> stale -> reloading -> ready`.

## Sync/Transfer Behavior

- Prioritize transfer reliability over background metadata churn.
- Keep protocol ingestion and transfer paths clearly separated.
- Use bounded/coalesced processing for noisy update streams.
- Be explicit about active folder scope and update scope.

## Testing Expectations

- Add tests that reproduce real workload patterns, not only happy paths.
- Use only repository-managed local fixtures or an explicitly configured test
  server as test peers. Real-world peer identifiers, addresses, and devices
  found in logs are diagnostic evidence only and must never be contacted or
  reused as test targets.
- Do not weaken tests to make them pass.
- Prefer root-cause fixes over timeout inflation.
- Include stress tests for:
  - concurrent metadata churn,
  - active transfer under load,
  - explicit state transition correctness.

## Style and Quality

- Use existing standards/formats unless there is a strong reason not to.
- Keep compatibility/migration in mind (data should be portable when possible).
- Keep visual/style changes minimal unless explicitly requested.
- Run lightweight checks after edits (typecheck/tests relevant to changes).
