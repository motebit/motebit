---
"motebit": patch
---

Tighten the published-package README so the runtime/CLI distinction is precise, and align spec/package counts with reality.

## Why

The `motebit` package is the bundled reference runtime — relay, policy engine, sync engine, MCP server, and wallet adapters inlined into a single binary. The CLI is its primary operator-facing surface, not the artifact itself. The prior README opener ("the motebit CLI is published as a binary") was an elegant one-sentence framing that read accurately to someone scanning, but understated what the package actually contains and slipped against the package's own description field ("Reference runtime and operator console").

A reviewer pulling on the framing surfaced the imprecision in two rounds. Fixing it locally without auditing siblings would have left the published-artifact prose drifting from the npm metadata it ships beside, so the cleanup also re-checked counts and package-table coverage at the same time.

## What shipped

- `apps/cli/README.md` — new "How it ships" section opens with `motebit` as the bundled reference runtime and reframes the CLI as one of its surfaces. Restates the public-promise sentence: subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes, and MCP server tool list — not the internal workspace package graph.
- Root `README.md` — package table expanded from 7 rows to 11 so all four hardware-attestation Apache-2.0 leaves (`crypto-appattest`, `crypto-play-integrity`, `crypto-tpm`, `crypto-webauthn`) are visible alongside the rest of the published surface in one place. New "Versioning" section adjacent to "Licensing" makes the published-vs-private split explicit.
- Spec count: `12` → `19` across root README (×4), `CLAUDE.md`, and `apps/docs/content/docs/operator/architecture.mdx`. The seven specs missing from earlier enumerations (`agent-settlement-anchor`, `consolidation-receipt`, `device-self-registration`, `goal-lifecycle`, `memory-delta`, `plan-lifecycle`, `computer-use`) are real specs with reference implementations; the prose just hadn't been updated.
- Package count: `36` / `40` / `37` → `46` across the same three surfaces. `pnpm check-docs-tree` validates the new numbers.
- Five empty `auto-generated patch bump` changeset stubs deleted so they don't pollute the next CHANGELOG entry with content-free lines.

## Impact

Zero runtime change. Zero API change. The `motebit` patch bump exists because `apps/cli/README.md` is in the package's `files` array — the README that ships to npm changes, so the published version should reflect it. Smoke test (`npm install motebit@1.0.0 && motebit doctor` from a clean tmp directory) passes all six checks including Secure Enclave detection on Apple Silicon hosts; the cleanup is purely textual.

Three follow-ups are tracked separately: a `check-cli-surface` drift gate to bring CLI-surface rigor up to the protocol-floor `check-api-surface` standard, sentinel versioning on the 35 private workspace packages so their `0.x` numbers stop carrying unintended semver social meaning, and a CI gate that rejects empty changeset bodies at the source.
