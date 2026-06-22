# Coverage graduation

Two policies, one direction.

**Floor (invariant).** Coverage thresholds never lower. Every `vitest.config.ts` declares its measured baseline; CI fails if a regression lands. Enforced by `turbo run test:coverage` (drift-defenses #5) and the `defineMotebitTest` factory in `vitest.shared.ts` (which makes thresholds a required argument). Anchored in the `feedback_coverage_thresholds` memory.

**Ceiling (commitment).** Money + identity path packages whose floor sits below the project's 80% target carry an explicit raise-by date in `coverage-graduation.json`. **Soft before the date, hard on or after it** (issue #111): `pnpm coverage-graduation` (the `check-coverage-graduation` gate) prints the timeline and exits 0 while every commitment is still in its window; once an entry's `target_date` passes with its `target` still unmet, CI fails. The deadline is enforced; the target itself stays team-chosen.

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

A package is **a graduation candidate** when any axis of its declared threshold is below 80. As of 2026-06-21 the manifest carries six entries — `@motebit/core-identity` (raise-by 2026-08-15) plus the five hardware/aggregator verifiers (`crypto-{appattest,android-keystore,tpm,webauthn}`, `verify`; raise-by 2026-09-30), added by the money/identity coverage slate. An earlier graduation, `@motebit/wallet-solana`, went 42/86/58/42 at the 2026-04-16 baseline → raised in three passes (memo-submitter → rail.ts → jupiter.ts) to 97/96/100/97 by 2026-04-20, then removed from the manifest ahead of the 2026-06-01 deadline per the "when all targets are met, remove the entry" rule. See `packages/wallet-solana/vitest.config.ts` for the per-pass narrative.

## Manifest

`coverage-graduation.json` at the repo root. The shape when an entry is active:

```json
{
  "policy": "soft-before-deadline",
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

When `packages` is `[]` the quiet state is an explicit statement that no money/identity package is below floor; today it carries the six slate entries above.

Three states per entry:

- **Active** — current < target on at least one axis. The report shows the gap and remaining days.
- **Drift** — manifest `current` no longer matches the live `vitest.config` thresholds. Update the manifest in the same PR that raised the threshold; if all targets are now met, remove the entry.
- **Overdue** — `target_date` has passed and targets unmet. **CI fails (exit 1)** — a commitment past its date that nobody honored is a broken promise, the opt-in fail-open this primitive exists to close. Close the gap (raise the threshold) or re-target with a rationale; never silently extend the date.

When all targets are met, remove the entry. When a new package belongs in scope, add one.

## Soft before the deadline, hard after (and why that isn't theatre)

The original doctrine kept this soft, reasoning that a hard gate saying "wallet-solana must reach 80% by 2026-06-01" is theatre — either the date slips and the gate is disabled (band-aid), or the date drives test-quantity over test-quality (`feedback_endgame_not_mvp`). That reasoning was right about a _naive_ hard gate, and the escalation (issue #111) **keeps the insight** rather than discarding it:

- The gate does NOT mandate a universal target or dictate "more tests." The team still chooses each entry's `target` and `target_date`. What the gate enforces is only that a commitment _already made_ isn't silently abandoned once its date passes.
- The escape valve is not "disable the gate." Past the date with the target unmet, the honest closes are (a) raise the threshold to the committed target, or (b) re-target with a doctrine-grade rationale. **Silently extending the date is the one move that's forbidden** — it's the band-aid the original concern named.

What changed is the stakes. The primitive is now load-bearing: the money/identity coverage slate put six entries under graduation (sized for three). At that scale a soft signal is an _opt-in fail-open_ — a raise-by date that passes unread rots silently, the exact shape the slate was built to forbid, recurring one layer up inside graduation itself. Soft-before-the-date preserves the "someone reads it" conversation; hard-after makes the deadline a real boundary instead of a suggestion. Landed before the earliest live date (2026-08-15, `@motebit/core-identity`) so the discipline is exercised against a real deadline, not a hypothetical.

A package's coverage regressing below the manifest's recorded `current` snapshot is already a CI failure (the floor invariant) before this report runs — that half was always hard.

## How to use

Run `pnpm coverage-graduation`. The output is a per-package timeline. If the package is yours and the date is approaching, that's the conversation; if the date has slipped and you don't have a plan, that's a different conversation.

Adding tests follows the package's own doctrine (see `packages/wallet-solana/CLAUDE.md` for the sovereign rail's adapter-test pattern). The graduation manifest does not prescribe how to close the gap — only that it must close.
