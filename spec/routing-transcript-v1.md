# motebit/routing-transcript@1.0

## Routing-Decision Transcript Specification

**Status:** Stable
**Version:** 1.0
**Date:** 2026-07-21

Doctrine: [`docs/doctrine/routing-decision-transcript.md`](../docs/doctrine/routing-decision-transcript.md). JSON Schema: [`spec/schemas/routing-transcript-v1.json`](schemas/routing-transcript-v1.json).

## 1. Scope

A `RoutingDecisionTranscript` is the delegator's signed, self-contained record of why a worker won a paid hire: the frozen admissible candidate set, the per-candidate inputs the ranking actually consumed, the decision parameters, and the outcome.

### The boundary (load-bearing)

Subject **=** signer: the delegator records its **own** act of choosing, so the transcript is receipt-family first-person provenance (`docs/doctrine/receipts-unified.md`), not an attestation (`spec/eval-attestation-v1.md`, whose defining property is subject ≠ signer).

The transcript **reveals, never authorizes**: no verification outcome feeds any admission gate or money authority. Disclosure is dispute-scoped — the per-candidate posteriors are reads of the delegator's private trust ledger, retained locally and egressed on dispute or by owner choice, never broadcast. Aggregation of transcripts into any cross-delegator reputation is REFUSED by doctrine.

## 2. Wire format

### 2.1 — RoutingDecisionTranscript

#### Wire format (foundation law)

The `RoutingDecisionTranscript` type is exported from `@motebit/protocol` (`routing-transcript.ts`). Required fields: `spec` (literal `"motebit/routing-transcript@1.0"`), `capability`, `delegator_motebit_id`, `delegator_public_key` (lowercase hex, 64 chars), `candidates` (non-empty, ranked order), `seed` (the tick token's Ed25519 signature — a recorded, signed artifact binding the transcript to the delegation turn), `strength` ∈ [0,1] (base exploration strength, pre-bond-boost), `weights` (`trust`/`reliability`/`cost`/`latency`), `count_cap`, `bond_explore_boost`, `default_latency_ms` (the ranker's internal constants, frozen as literals), `algorithm_version`, `winner_motebit_id` (MUST be a member of `candidates`), `explored`, `issued_at` (epoch ms), `suite` (literal `"motebit-jcs-ed25519-b64-v1"`), `signature`. Optional: `pinned` (literal `true` — the hire was a deterministic `targetWorkerId` override; no draw ran; `candidates` holds the pinned worker alone). JCS discipline: optional fields are ABSENT, never null.

### 2.2 — TranscriptCandidate

#### Wire format (foundation law)

The `TranscriptCandidate` type is exported from `@motebit/protocol`. Required: `motebit_id`, `trust_axis`, `reliability_axis` (the axis values the composite consumed — in explore mode both carry the Thompson-blended quality). Optional: `unit_cost` (absent ⇒ free), `bonded` (literal `true` ONLY when a relay-RPC-verified commitment bond backed the candidate at decision time — the explicit-true discipline), and the explore-mode posterior triple `alpha`, `beta` (integer pseudo-counts: level prior + ratio-capped task counts) and `theta` (the draw — redundant with `(alpha, beta, seed)` by construction, carried so a lying transcript is catchable).

## 3. Signing

Ed25519 over `canonicalJson({ ...transcript minus signature })` (RFC 8785 JCS), base64url-encoded, suite-dispatched (`motebit-jcs-ed25519-b64-v1`). Producer law: `signRoutingTranscript` in `@motebit/crypto`. The artifact is self-describing (`delegator_public_key` embedded); PQ migration is a new `SuiteId` + dispatch arm, not a wire break.

## 4. Verification law — two rungs

**Rung 1 — integrity** (`verifyRoutingTranscript`, `@motebit/crypto`, re-exported by `@motebit/verifier` — Apache-2.0 permissive floor): suite, spec, non-empty candidate set, winner-membership, key/signature shape, signature over the canonical bytes. Establishes "this delegator committed to this decision record" — nothing more. Fail-closed with typed reasons: `unsupported_suite`, `unsupported_spec`, `empty_candidates`, `winner_not_in_candidates`, `malformed_public_key`, `malformed_signature`, `signature_invalid`.

**Rung 2 — faithfulness** (`recomputeRoutingDecision`, `@motebit/semiring` — source-available, deliberately outside the permissive floor because it IS the ranking judgment): recompute the decision from the frozen inputs. (a) The draw chain: for each candidate carrying a posterior, re-derive θ̃ = Beta(α, β) seeded by `${seed}|${motebit_id}` (FNV-1a → mulberry32 → ratio-of-Gammas — a deterministic simulation PRNG, not a VRF) and the blended quality `mean + strength·(θ̃ − mean)` (bonded candidates use `min(1, strength × bond_explore_boost)`), and match `theta` / axis values exactly. (b) The composite: rebuild the ranking from the frozen axis values × the recorded weights, ties broken by `motebit_id` ascending, and match `winner_motebit_id`. Typed outcomes: `unsupported_algorithm_version`, `empty_candidates`, `theta_mismatch`, `axis_mismatch`, `winner_mismatch`.

Determinism is **same-version**: `algorithm_version` pins the ranking implementation (`WORKER_SELECTION_ALGORITHM_VERSION`); an unknown version is rejected, never guessed at. Cross-engine bit-identity is not guaranteed (last-ULP caveat — golden vectors pin same-version identity).

Deliberately out of scope for both rungs: the truth of the frozen posteriors (the delegator's own ledger; its honesty is the ledger's provenance discipline), the delegator key → `motebit_id` binding (the consumer's `verifySovereignBinding`-shaped responsibility), and the `explored` flag (informative — its exploit-side comparison inputs are not frozen).

## 5. Production

The transcript basis is minted ONLY by the real selection code path — `rankWorkersWithBasis` in `@motebit/semiring` freezes the consumed inputs at decision time (produced-basis; `docs/doctrine/felt-accumulation.md` honesty floor). The runtime adds identity, `issued_at`, and the envelope, and signs. A pinned hire mints a trivial transcript (`pinned: true`, no draw). Producer wiring is Inc 3 of the arc; the conformance probe asserting a verified transcript is Inc 4.

## 6. Conformance corpus

[`spec/conformance/routing-transcript/corpus.json`](conformance/routing-transcript/corpus.json) — signed fixtures with expected integrity verdicts (clean, pinned, tampered-winner, winner-outside-set, unsupported-suite, unsupported-spec, empty-candidates, malformed-key, malformed-signature) plus faithfulness fixtures (consistent, theta-tampered, winner-tampered). Generator: `scripts/gen-routing-transcript-corpus.ts`; validated in-repo by `packages/crypto/src/__tests__/routing-transcript-conformance.test.ts` and `packages/semiring/src/__tests__/worker-selection-transcript.test.ts`.
