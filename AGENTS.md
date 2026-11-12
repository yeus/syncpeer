# AGENTS.md

AI agents working in this repository must read and follow:

- [`development_instructions.md`](./development_instructions.md)

When there is conflict between local implementation habits and repository style,
follow `development_instructions.md`.

TypeScript should infer types from the `.ts` source wherever possible. Keep
hand-written declaration files to the absolute minimum for unavoidable external
or tooling shims; do not duplicate the public API in `.d.ts` files. This rule
takes priority over satisfying a lint rule by adding manual declarations.

## System definition catalog

- Treat `SYSTEM_DEFINITION.csv` as Syncpeer's canonical system definition for agents and the
  human-readable overview of product behavior, architecture, implementation evidence, validation,
  milestones, and known limitations. It is not optional release notes or secondary documentation.
- Every software change must update the relevant row or rows in `SYSTEM_DEFINITION.csv`
  in the same change. Keep the requirement description, status, surface,
  compatibility, implementation paths, verification evidence, milestone,
  source, and notes synchronized with the resulting behavior.
- Do not mark a requirement implemented or verified beyond the available
  evidence. Record partial coverage and remaining limitations explicitly.

## Release candidates

- Follow the release-candidate policy in `development_instructions.md`.
- In particular, do not prepare or publish an RC while a feasible automated/local acceptance gate for that release is still failing or unverified.
- Treat the RC period as the phase for physical-device and real-world validation before the stable release.

## Release gate: automate to rc.1, then verify on devices

- Every release cycle reaches `-rc.1` using only automated evidence: unit, integration, script,
  browser, emulator, static, packaging, and version-consistency checks. Do not block rc.1 on
  physical-device, OEM, network-handoff, or app-store evidence that cannot be produced
  automatically.
- Test physical devices, real networks, OEM power management, and store review on the rc.1
  artifact itself. When that evidence passes, promote the same source revision for the final
  release instead of changing behavior late in the cycle.
- A requirement that still needs device or store evidence stays `planned` in the system definition
  and is named as a known limitation in the rc.1 release notes. Never promote it to `implemented`
  or `tracked` from emulator-only or one-off manual checks.
- Record the rc.1 gate evidence (command, runner, result, unproved items) in the owning
  documentation so the promotion decision is auditable.
