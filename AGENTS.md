# AGENTS.md

AI agents working in this repository must read and follow:

- [`development_instructions.md`](/workspace/development_instructions.md)

When there is conflict between local implementation habits and repository style,
follow `development_instructions.md`.

TypeScript should infer types from the `.ts` source wherever possible. Keep
hand-written declaration files to the absolute minimum for unavoidable external
or tooling shims; do not duplicate the public API in `.d.ts` files. This rule
takes priority over satisfying a lint rule by adding manual declarations.

## Feature requirements catalog

- Treat `FEATURES.csv` as Syncpeer's canonical feature requirements catalog, not
  as optional release notes or secondary documentation.
- Every software change must update the relevant row or rows in `FEATURES.csv`
  in the same change. Keep the requirement description, status, surface,
  compatibility, implementation paths, verification evidence, milestone,
  source, and notes synchronized with the resulting behavior.
- Do not mark a requirement implemented or verified beyond the available
  evidence. Record partial coverage and remaining limitations explicitly.
