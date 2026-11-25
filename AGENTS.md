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

1. **Development (`0.1.0-dev`) — AI implementation and automated acceptance.**
   Finish all in-scope behavior and every feasible automated check: unit, integration,
   security-negative, browser/E2E, emulator, type/lint/static, production build,
   packaging, version consistency and applicable deployment smoke tests. Reuse owning
   tests, fix failures at their source, and rerun affected checks and the release suite.
   Do not hand feasible automated work to the maintainer or silently defer scope.
2. **Alpha (`0.1.0-alpha.1`) — manual pre-RC acceptance.** Only after the automated
   gate passes, prepare an identifiable, installable alpha with a manual checklist,
   setup instructions, known limitations, source/dependency revisions and artifact
   checksums. Alpha is feature-complete for its intended release scope, not an
   unfinished development snapshot. The maintainer tests usability, actual-device
   installation/upgrade, live accounts, recovery and other human-dependent behavior.
   Fix reported defects, add regressions, rerun checks and issue `-alpha.2`, etc.
   Publish rc.1 only after the maintainer accepts the alpha.
3. **Release candidate (`0.1.0-rc.1`) — real-world field validation.** Freeze the
   accepted source and dependency revisions and publish immutable candidate artifacts
   with explicit authorization. Exercise real devices, networks, workloads, lifecycle,
   interoperability and applicable store review for an agreed period. Fix blockers,
   repeat the automated and affected manual gates, and issue `-rc.2`, etc. Never
   replace a published alpha or RC in place.
4. **Stable (`0.1.0`) — promote the accepted RC.** Require maintainer acceptance of
   field evidence and no release-blocking defects. Promote the same reviewed behavior
   apart from version metadata and necessary packaging/signing changes; rerun build,
   version and artifact checks. Behavior changes require another candidate.

Use numbered SemVer prereleases (`-alpha.1`, `-rc.1`), not `-a` or a separate beta
stage. The development label is illustrative; do not change existing version metadata,
release tags or publishing workflows without an explicit task to do so.

### Release evidence

- Record the scope, implementation status, automated results (commands, runner,
  revision, pass/fail/skip counts), manual alpha acceptance and RC field evidence
  separately in the owning system definition/release matrix or equivalent documentation.
  A focused or historical pass is not a current full-suite pass.
- Document inaccessible hardware/services and genuinely external checks. Do not count
  an unrun check as passing, or move a failing feasible automated gate to alpha/RC.
  Reserve checks inherently requiring a released candidate for the RC phase.
- Preparation, successful checks and readiness do not authorize commits, staging, tags,
  pushes or production activation. Preserve existing project-specific requirements.

Syncpeer's alpha must cover physical-device installation/upgrade, pairing, basic
synchronization and recovery. RC field testing covers sustained transfers, real
networks/NAT/relay, OEM power management, handoff, lifecycle and store review.
Follow the additional release rules in development_instructions.md.
