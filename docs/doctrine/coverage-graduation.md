# Coverage graduation

Two policies, one direction.

**Floor (invariant).** Coverage thresholds never lower. Every `vitest.config.ts` declares its measured baseline; CI fails if a regression lands. Enforced by `turbo run test:coverage` (drift-defenses #5) and the `defineMotebitTest` factory in `vitest.shared.ts` (which makes thresholds a required argument). Anchored in the `feedback_coverage_thresholds` memory.

**Ceiling (commitment).** Money + identity path packages whose floor sits below the project's 80% target carry an explicit raise-by date in `coverage-graduation.json`. Soft signal — `pnpm coverage-graduation` prints the timeline; CI does not fail. Escalated to a hard gate only if the soft signal is ignored.

The floor prevents decay. The ceiling prevents stasis at a low baseline.

## Scope

The packages on the **money path** or the **identity path** — anything where a coverage gap is a financial or cryptographic risk, not a developer-ergonomics one:

- `@motebit/wallet-solana` — sovereign rail, signs transfers
- `@motebit/crypto` — every signature in the system routes here
- `@motebit/core-identity` — identity bootstrap and persistence
- `@motebit/virtual-accounts` — the per-motebit ledger
- `@motebit/settlement-rails` — the three guest rails + registry
- `@motebit/evm-rpc` — JSON-RPC behind the deposit detector
- `@motebit/deposit-detector` — what credits an account when value lands

A package belongs in this scope when an untested path could move money, sign on behalf of an identity, or admit a signed artifact that should have been rejected.

A package is **a graduation candidate** when any axis of its declared threshold is below 80. As of 2026-04-24 the manifest is empty — every in-scope package sits at or above the 80/80/80 target. The most recent graduation was `@motebit/wallet-solana`: 42/86/58/42 at the 2026-04-16 baseline, raised in three passes (memo-submitter → rail.ts → jupiter.ts) to 97/96/100/97 by 2026-04-20, then removed from the manifest ahead of the 2026-06-01 deadline per the "when all targets are met, remove the entry" rule. See `packages/wallet-solana/vitest.config.ts` for the per-pass narrative.

## Manifest

`coverage-graduation.json` at the repo root. The shape when an entry is active:

```json
{
  "policy": "soft-signal",
  "scope": "money + identity path packages",
  "packages": [
    {
      "package": "@motebit/wallet-solana",
      "vitest_config": "packages/wallet-solana/vitest.config.ts",
      "current": { "statements": 42, "branches": 86, "functions": 58, "lines": 42 },
      "target": { "statements": 80, "branches": 86, "functions": 80, "lines": 80 },
      "target_date": "2026-06-01",
      "rationale": "..."
    }
  ]
}
```

Today `packages` is `[]` — the quiet state is an explicit statement that no money/identity package is below floor.

Three states per entry:

- **Active** — current < target on at least one axis. The report shows the gap and remaining days.
- **Drift** — manifest `current` no longer matches the live `vitest.config` thresholds. Update the manifest in the same PR that raised the threshold; if all targets are now met, remove the entry.
- **Overdue** — `target_date` has passed and targets unmet. The soft signal still exits 0; the conversation it forces is the point.

When all targets are met, remove the entry. When a new package belongs in scope, add one.

## Why soft, not hard

A hard CI gate that says "wallet-solana must reach 80% by 2026-06-01" would be theatre — either the date slips and the gate is disabled (band-aid), or the date drives test-quantity over test-quality (`feedback_endgame_not_mvp`). The signal works because someone reads it; the doctrine names when to escalate:

- The same target date is missed twice without rationale → promote to `check-coverage-graduation` as a hard gate.
- A package's coverage regresses below the manifest's recorded `current` snapshot → already a CI failure (the floor invariant) before this report runs.

## How to use

Run `pnpm coverage-graduation`. The output is a per-package timeline. If the package is yours and the date is approaching, that's the conversation; if the date has slipped and you don't have a plan, that's a different conversation.

Adding tests follows the package's own doctrine (see `packages/wallet-solana/CLAUDE.md` for the sovereign rail's adapter-test pattern). The graduation manifest does not prescribe how to close the gap — only that it must close.
