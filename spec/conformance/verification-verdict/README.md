# VerificationVerdict conformance corpus

A versioned, pinnable set of vectors for the `VerificationVerdict` — the structured verify result that replaces the verify family's bare booleans (see [`docs/doctrine/verify-family-fail-closed.md`](../../../docs/doctrine/verify-family-fail-closed.md) § "The VerificationVerdict arc"). The corpus is the interop contract: a second implementation runs **its** verifiers over the same `input` and asserts the same `expected`. "Done" is both sides emitting identical verdicts with neither author in the room.

## The verdict

A `VerificationVerdict` reports what each axis **established** and what remains **unknown**. It deliberately has **no top-level `valid` boolean** — a consumer branches on the axis it depends on, so an `unchecked` / `stale` / `unverified` / `unknown` result cannot silently read as a pass. The governing rule:

> No unknown, unchecked, stale, or integrity-only result may silently read `true`.

Axes:

| axis              | values                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `integrity`       | `verified` \| `invalid`                                                                   |
| `identityBinding` | `sovereign` \| `anchored` \| `pinned` \| `unverified` \| `invalid`                        |
| `authority`       | `valid` \| `expired` \| `not_yet_valid` \| `insufficient` \| `unknown`                    |
| `revocation`      | `{ status: "fresh" \| "stale" \| "unchecked" \| "revoked"; freshness?: { asOf, basis } }` |
| `temporalBasis`   | `clockless` \| `local_clock` \| `ledger_anchored`                                         |
| `evidenceBasis`   | `{ kind, ref }[]`                                                                         |
| `repair?`         | `{ code, axis, summary, canonical?, fix }` — present on any non-passing axis              |

`revocation.freshness.basis` is an evidence-grade ladder, weakest to strongest: `asserted` < `stapled` < `ledger`. `asserted` = holder-asserted, no external anchor; a consumer **down-weights** it. The verdict carries the basis; it does not assign a weight — the consumer holds the tolerance.

`authority` and `revocation` are **orthogonal**: a revoked grant's tick that is itself well-formed and in-TTL reads `authority: "valid"` + `revocation: "revoked"`, not `authority: "insufficient"`. That separation is the point — the bare boolean reads a pass; the verdict can't.

## Cases

Each case is `{ name, kind, description, input, expected }`. Run the producer named by `kind` over `input`, assert the result deep-equals `expected`:

- `kind: "receipt"` → `verifyReceiptVerdict(input.receipt)`
- `kind: "delegation_token"` → `verifyDelegationTokenVerdict(input.token, input.grant, input.options)`

The set spans the canonical fixtures: a sovereign-but-not-pinned receipt, a tampered receipt, an embedded-key-only receipt, a revoked-grant tick that still self-mints, and a pre-minted future-slot token under a rolled-back clock judged by **ordering** (`clockless`, valid) vs **wall-clock** (`local_clock`, `not_yet_valid`) — the pair proving a consumer must branch on `temporalBasis`.

## Determinism & regeneration

Every artifact is minted from fixed private keys; Ed25519 keygen and signing are deterministic, so the corpus is byte-stable. The reference implementation's agreement is enforced by `packages/crypto/src/__tests__/verdict-corpus-conformance.test.ts` (CI fails if a producer drifts from the committed `expected`). Regenerate deliberately, on a reviewed producer change:

```
npx tsx scripts/gen-verdict-corpus.ts
```

## Pinning

Pin by path + commit. The vectors are language-neutral JSON: signed artifacts plus verifier options and the expected verdict. A non-motebit verifier needs only these vectors and an Ed25519 library — no relay contact, no motebit runtime.
