# Dissolution spectrum — persistence's multi-axis physics

[`LIQUESCENTIA.md`](../../LIQUESCENTIA.md) §V.5 names persistence: the medium permits a motebit to cohere "as long as its internal cohesion exceeds the medium's dissolution pressure." Until this doctrine, that pressure was metaphor — evocative, but unlike breathing rhythm (`~0.3 Hz` derived from `ω² = n(n-1)(n+2)σ/ρR³`, see [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) §V.2), it had no equation, no constant, no code-anchored derivation.

This doctrine closes that asymmetry. Dissolution pressure is **multi-axis** — a spectrum of decay constants, one per persistence axis — and each axis has a real value in code today. The aggregate determines whether the motebit's interior cohesion exceeds the medium's claim on it.

## Why a spectrum, not a single rate

The body's breathing is single-axis: one resonant cavity, one Rayleigh frequency. Persistence is multi-axis: identity, memory, trust, credentials, audit, and retention each decay at their own rate. A real droplet behaves the same way — mass loss (evaporation), energy loss (cooling), structural relaxation, and surface-tension drift each have their own time constants. They are all "dissolution," but at different scales.

This is rigor across dimensions, not absence of rigor. Same shape as the [`HardwareAttestationSemiring`](hardware-attestation.md)'s additive scoring across platforms — multiple inputs, one composed result.

## The five axes

Each axis carries a code-anchored constant, a decay form (exponential / cliff / capacity), and a doctrinal binding.

### 1. Memory dissolution — `recencyHalfLife` + per-node `half_life`

**Code home.** `packages/memory-graph/src/index.ts` — `DEFAULT_SCORING_CONFIG.recencyHalfLife` (24h; recency boost reaches 0.5 at this elapsed time) + per-node `node.half_life` consumed by `computeDecayedConfidence(initialConfidence, halfLife, elapsedMs) = initialConfidence * 0.5^(elapsed/halfLife)`.

**Form.** Exponential decay. `confidence(t) = confidence(0) · 2^(−t/τ_M)`.

**Default constant.** `τ_M_recency = 24h` (interaction recency). Per-node `τ_M_node` set per memory; high-confidence nodes get longer half-lives, observations get shorter ones.

**Doctrinal binding.** Knowledge is the most ephemeral persistence axis — un-reinforced facts fade fast. The motebit's _consolidation cycle_ (see [`proactive-interior.md`](proactive-interior.md)) is the active reinforcement mechanism that resists this dissolution; without consolidation, memory is the first thing the medium reclaims.

### 2. Trust dissolution — `RECENCY_HALF_LIFE_DAYS = 90`

**Code home.** `packages/policy/src/reputation.ts:24` — `RECENCY_HALF_LIFE_DAYS = 90`; reputation score uses `Math.exp(-daysSinceLastSeen / RECENCY_HALF_LIFE_DAYS)`.

**Form.** Exponential decay. `trust(t) = trust(0) · e^(−t/τ_T)`. (Mathematically equivalent to a base-2 half-life of `τ_T · ln(2) ≈ 62.4` days.)

**Default constant.** `τ_T = 90` days.

**Doctrinal binding.** Trust is the relational persistence axis — without continued interaction, peer trust scores decay. The 90-day choice is roughly one quarter; long enough that occasional collaborators don't fall out of trust, short enough that abandoned relationships dissolve back to first-contact baseline. Departing from this rate needs a relational-physics argument (e.g., "the federation peer cycle is 30 days, so τ_T = 90 gives three turns of grace"), not aesthetic preference.

### 3. Credential dissolution — `validUntil` cliff

**Code home.** `packages/crypto/src/credentials.ts:223–225` — `if (Date.now() > expiresAt) return false;` against the credential's `validUntil` field.

**Form.** Hard cliff. `valid(t) = 1 if t < validUntil else 0`.

**Default constant.** Issuer-set per-credential. Trust credentials in motebit typically use `validForMs` argument at signing time; the issuer chooses based on the claim's nature (a "verified at delegation X" claim might be days; a long-form reputation claim might be months).

**Doctrinal binding.** Claim persistence is **issuer-bound**, not motebit-bound. The cliff form is correct: a verifiable claim either passes its expiration check or it doesn't. There is no "decayed" valid credential — credentials are binary. This is the only axis where the dissolution shape is non-continuous.

### 4. Retention dissolution — `MAX_RETENTION_DAYS_BY_SENSITIVITY`

**Code home.** `packages/protocol/src/retention-policy.ts:42` — `MAX_RETENTION_DAYS_BY_SENSITIVITY` (interop law: `Infinity` / `365` / `90` / `90` / `30` days for `none` / `personal` / `medical` / `financial` / `secret`); `REFERENCE_RETENTION_DAYS_BY_SENSITIVITY` (canonical relay's actual values, at-or-below the ceiling).

**Form.** Hard cliff per sensitivity tier. `retained(t) = 1 if t < ceiling[sensitivity] else 0`.

**Default constants.** Per [`retention-policy.md`](retention-policy.md):

- `none` → `Infinity` (no upper bound by law)
- `personal` → 365 days
- `medical` → 90 days
- `financial` → 90 days
- `secret` → 30 days

**Doctrinal binding.** Data persistence is **policy-bound**, with sensitivity acting as a permeability gradient (the more sensitive the data, the higher the dissolution pressure, the shorter it persists). This axis is the ONE that interop law constrains across implementations; alternative motebit implementations may ship stricter ceilings, never looser. See [`retention-policy.md`](retention-policy.md) for the three retention shapes (mutable pruning / append-only horizon / consolidation flush) and the signed `DeletionCertificate` discriminated union that proves dissolution actually happened.

### 5. Audit dissolution — `DEFAULT_MAX_ENTRIES = 10_000`

**Code home.** `packages/policy/src/audit.ts:14` — `DEFAULT_MAX_ENTRIES = 10_000`; FIFO eviction in `InMemoryAuditSink.append()`.

**Form.** Capacity-based FIFO. `retained(entry_n) = 1 if (n >= total_count - 10000) else 0`.

**Default constant.** `τ_A_capacity = 10,000` entries (not a time, a count).

**Doctrinal binding.** Audit persistence is **capacity-bound** today — the in-memory `AuditLogger` (PolicyGate's actual sink) holds the last N entries regardless of age. This is the most aggressive dissolution axis: a busy motebit can churn through 10,000 entries in days. The hash-chained `AuditChainStore` primitive (see [`audit_chain_signing_endgame`](../../.claude/projects/-Users-daniel-src-motebit/memory/audit_chain_signing_endgame.md) project memory) would replace capacity-FIFO with durable hash-chained persistence + Merkle anchoring; that's the endgame this axis points at.

## The three dissolution shapes

The five axes resolve into three structural forms — and these align exactly with [`retention-policy.md`](retention-policy.md)'s three retention shapes:

| Shape           | Examples                       | Retention-policy analog                          |
| --------------- | ------------------------------ | ------------------------------------------------ |
| **Exponential** | memory, trust                  | `mutable_pruning` (continuous)                   |
| **Cliff**       | credentials, retention ceiling | `consolidation_flush` (whole-record at boundary) |
| **Capacity**    | audit (today)                  | `append_only_horizon` (whole-prefix truncation)  |

This is not coincidence. Persistence and retention are the same physics observed from different sides — the medium dissolves what the policy doesn't actively retain. The two doctrines are co-derived from §V.5 + §V.4 (cohesive permeability).

## What "perfect 10" means now

Before this doctrine, persistence was the only Liquescentia property without code-anchored constants. Each of the four others (spectral gradient → `ENV_LIGHT`; quiescence → 0.3 Hz Rayleigh; luminous density → `CANONICAL_MATERIAL`; cohesive permeability → `PolicyGate`) had a clear answer to "what's the value, where does it live, why this number." Persistence had identity + memory as code references but no decay constants.

It does now. Each axis names its constant, its form, its code home, its doctrinal binding. Departing from any of them needs a coupling argument from the same physics — "we shorten τ_T to 30 days because the federation cycle is 10-day" is valid; "we shorten τ_T because it feels right" is not. The discipline matches breathing rhythm's: physical, not aesthetic.

## What remains as future direction

- **Hardware attestation TTL** is currently platform-set (Apple App Attest, Google Play Integrity, Microsoft TPM, etc. each define their own). A motebit-side override (e.g., "we treat any attestation older than τ_HA as stale even if the platform still trusts it") would add a sixth axis. Defer until a real federation consumer needs the override.
- **Audit signing endgame** — `AuditChainStore` exists as a hash-chained primitive; PolicyGate doesn't write to it (see project memory `audit_chain_signing_endgame`). When that wiring lands, audit dissolution moves from capacity-FIFO to anchor-pinned-merkle-chain — a fundamentally different shape.
- **Kelvin-equation-derived τ_M.** Today `τ_M_recency = 24h` is a chosen value with empirical fit. A first-principles derivation (motebit's "dissolution rate scales with cohesion-vs-medium-pressure ratio, by direct analog to `ln(P/P₀) = 2γVm / (RTr)`") would land memory's half-life in the same physics chain breathing came from. Real new content; deferred until either a peer-reviewer of the article asks or a third-party motebit implementer needs to know what τ_M to target.

## Connections to existing doctrine

- [`LIQUESCENTIA.md`](../../LIQUESCENTIA.md) §V.5 — the manifesto property this operationalizes.
- [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) §V.5 — the substrate doctrine; this file expands its persistence subsection into the spectrum.
- [`retention-policy.md`](retention-policy.md) — the retention side of the same physics. Three retention shapes ↔ three dissolution shapes; same underlying derivation.
- [`hardware-attestation.md`](hardware-attestation.md) — additive-scoring semiring across platforms; same multi-axis-then-aggregate pattern as the dissolution spectrum.
- [`proactive-interior.md`](proactive-interior.md) — the consolidation cycle is the active mechanism that resists memory dissolution; without it, the spectrum's first axis is the fastest to clear.
- [`agility-as-role.md`](agility-as-role.md) — each constant in the spectrum is a registry entry; the role (e.g., "memory recency half-life") is the constant in code, the value is the replaceable instance.

## The one-line summary

**Persistence is multi-axis. Five decay constants, three forms (exponential / cliff / capacity), one doctrinal grounding per axis. The medium's dissolution pressure is now as code-anchored as the body's breathing rhythm.**
