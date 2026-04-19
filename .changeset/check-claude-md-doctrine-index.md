---
---

Doctrine-index drift defense: every per-directory CLAUDE.md must be referenced from root.

A birds-eye review on 2026-04-18 caught the project's own meta-principle drifting at its own front door. Six package CLAUDE.md files added 2026-04-16 (`circuit-breaker`, `deposit-detector`, `evm-rpc`, `settlement-rails`, `virtual-accounts`, `self-knowledge`) had been silently absent from the root index. The numeric claims in root CLAUDE.md were stale too: "36 packages" (actual 37), "12 protocol specs" (actual 14), "16 drift defenses today" (actual 24, now 25). Same shape every gate before it has guarded — canonical truth (per-directory doctrine) lives in one place, the sibling copy (the root index) drifts.

This pass closes it:

- **`scripts/check-claude-md.ts`** — invariant #25. Walks the repo, collects every `CLAUDE.md` other than root, asserts each appears as a Markdown link target in root CLAUDE.md. Inversely, asserts every referenced path resolves to a file on disk so a stale link surfaces immediately after a package rename. Editorial concerns (the one-line description after each link, the grouping order) stay with the human — the gate only guards the existence link.

- **Root `CLAUDE.md` updated** — numbers corrected (37 packages, 14 specs, 25 invariants), Per-directory doctrine index expanded from 6 to 12 entries with a one-line gloss for each. The line itself is now self-attesting: it names `check-claude-md` as the enforcement so the next reader who adds a sub-CLAUDE.md sees the rule before tripping it.

- **`docs/drift-defenses.md`** — invariant #25 added to the inventory; incident history paragraph names the audit, the cause, and the fix. Header counts bumped (Twenty-five invariants, Eighteen hard CI gates).

Doctrine: extends [`docs/doctrine/self-attesting-system.md`](../docs/doctrine/self-attesting-system.md) one level inward — the doctrine-index is itself a claim that must resolve to something verifiable.
