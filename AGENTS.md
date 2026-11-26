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

## Release lifecycle: development → alpha → release candidate → stable

For every versioned release, follow this sequence (example target `0.1.0`):

1. **Development (`0.1.0-dev`) — autonomous agent implementation and sandbox acceptance.**
   Finish all in-scope behavior and every automated check the agent can actually
   execute in its available sandbox: unit, integration, security-negative,
   browser/E2E, disposable Android emulators, type/lint/static, production-mode
   builds, package/payload smoke tests, version consistency and applicable local
   deployment tests. Fix failures at their source and rerun affected and full
   release suites. Do not hand feasible sandbox automation to the maintainer.
2. **Alpha (`0.1.0-alpha.1`) — start of external/maintainer acceptance.**
   `-alpha.1` marks completion of feasible **autonomous sandbox** implementation
   and testing, not completion of real-device testing or release CI. Freeze a
   feature-complete candidate with a manifest, reproducible build instructions,
   known limitations, exact sandbox evidence, manual checklist and available
   candidate checksums. With explicit authorization, commit and tag the alpha;
   the tag may trigger CI to sign/package/publish distributable artifacts.
   During the alpha phase, verify external CI builds/signing/packaging, intact
   AppImage runtime and Flatpak on compatible hosts, real-phone installation,
   upgrade, pairing, synchronization and recovery, and human usability. Those
   checks **must not be required to declare alpha.1 sandbox-ready** when they
   cannot be performed autonomously before the candidate exists. Record them
   as pending alpha acceptance; never mislabel them as passed. Fix defects with
   regressions, rerun feasible sandbox gates and issue `-alpha.2`, etc. Publish
   `-rc.1` only after the maintainer accepts the alpha.
3. **Release candidate (`0.1.0-rc.1`) — real-world field validation.** Freeze
   accepted source/dependency revisions and publish immutable candidate artifacts
   with explicit authorization. Exercise sustained transfers, real networks,
   NAT/relay, OEM power management, handoff, lifecycle and store review for the
   agreed soak period. Fix blockers, repeat applicable gates and issue `-rc.2`,
   etc. Never replace a published alpha or RC in place.
4. **Stable (`0.1.0`) — promote the accepted RC.** Require maintainer acceptance of
   field evidence and no release-blocking defects. Promote the same reviewed behavior
   apart from version metadata and necessary packaging/signing changes; rerun build,
   version and artifact checks. Behavior changes require another candidate.

Use numbered SemVer prereleases (`-alpha.1`, `-rc.1`), not `-a` or a separate beta
stage. The development label is illustrative; do not change existing version metadata,
release tags or publishing workflows without an explicit task to do so.

### Release evidence and phase boundaries

- Record scope, implementation, sandbox test results (commands, runner, revision,
  pass/fail/skip counts), CI artifact/signing results, alpha manual acceptance and
  RC field evidence **separately** in the system definition/release matrix.
- A focused or historical pass is not a current full-suite pass. Document actual
  sandbox limitations with reasons; a genuinely runnable failing automated gate
  is a development blocker, not something to defer by renaming it external.
- CI workflows requiring a tagged candidate, private release keys, privileged
  builders or a compatible external OS; physical-device testing; and maintainer
  usability acceptance belong to the **alpha phase**, after the sandbox gate.
  CI publication requires explicit authorization and must never be implied by
  the word "ready". Absence of those external results does not prevent declaring
  alpha.1 **sandbox-ready**, but does prevent claiming distributable artifacts
  verified or alpha acceptance complete.
- Preparation and successful checks never authorize commits, staging, tags,
  pushes or publication. Preserve project-specific release permissions.

Syncpeer's alpha **acceptance** covers physical installation/upgrade, pairing,
basic synchronization and recovery. These are performed *using alpha artifacts*,
not prerequisites for reaching alpha.1. RC covers prolonged real-network/device
field validation. Follow development_instructions.md.
