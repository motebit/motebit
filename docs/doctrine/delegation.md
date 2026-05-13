# Delegation

Delegation is the architectural primitive that turns motebit's other five primitives into a system rather than a catalog.

## The spine: delegation is the connector, not the sixth sibling

Identity, trust, receipts, settlement, policy/permissions — without delegation, each is static:

- **Identity** is a fact (a public key sits there, doing nothing)
- **Trust** is a measure (a number with no thing being measured)
- **Receipts** are records (proofs of nothing happening to anyone)
- **Settlement** is a transaction (money moving for no reason)
- **Policy / permissions** is a constraint (gating no flow)

With delegation, all five become dynamic and the architecture COMPOSES:

- **Identity flows** from user to agent through cryptographically-signed scope
- **Trust accumulates** as delegated work resolves successfully — the agent earned reputation through delegation outcomes
- **Receipts attest** to delegated work specifically — the audit trail is the receipt of _what was delegated and how it resolved_
- **Settlement closes** the loop the delegation opened — receipt is the settlement trigger because receipt is the delegation-resolution evidence (per [`spec/delegation-v1.md`](../../spec/delegation-v1.md) §2)
- **Policy** is one slice of what delegation authorizes — policy is the **scope** of a delegation, not the delegation itself

This is why the [`docs/doctrine/audits/2026-05-13-positioning-architecture-audit.md`](audits/2026-05-13-positioning-architecture-audit.md) caught "permissions" / "policy" as a tagline asymmetry: both describe the SCOPE of delegation but neither names the RELATIONSHIP that delegation enables. The right tagline word is **delegation** because it names the relationship; "permissions" and "policy" name only the scope. The doctrine memo for the relationship-shaped primitive is this one.

## Two layers of invariants

Delegation is a relational primitive — its invariants split into wire-shape (proves the signature is authentic) and semantic constraints (makes the delegation usable). Conflating them obscures what makes delegation richer than just-another-signed-receipt.

### Cryptographic invariants (wire shape — three)

1. **Identity-bound + Ed25519-signed via the `SuiteId` registry.** Every delegation token / task / receipt is signed by the delegator's Ed25519 keypair (suite-dispatched per [`agility-as-role.md`](agility-as-role.md), so PQ migration is a registry append, not a wire-format break). The signature binds the delegation to a specific `MotebitId`; delegations are never anonymous.
2. **JCS-canonicalized.** RFC 8785 JSON Canonicalization Scheme — the bytes that get signed are byte-identical across implementations. Same invariant as [`receipts-unified.md`](receipts-unified.md) — the wire shape is stable.
3. **Independently verifiable** via `@motebit/verifier` (Apache-2.0, zero monorepo deps). A third party with the delegator's public key can verify any delegation offline without relay contact. The CLI tool `motebit-verify` bundles the path: `motebit-verify delegation-receipt <json>`.

### Semantic invariants (relational shape — three)

1. **Scope-bounded.** Delegations carry an explicit capability set (`required_capabilities` in §3.1, `delegated_scope` in §5.1) drawn from `delegation-v1.md` §7.0's canonical capability vocabulary. Blanket "do anything as me" delegations are NOT a wire-format possibility — every delegation is scope-constrained at the wire level. A worker that operates outside the delegated scope produces a receipt that fails scope-verification.
2. **Time-bounded.** Every delegation has a TTL after which it transitions to the terminal `expired` state (§4). Terminal states are irreversible — once expired, a delegation cannot be revived; the delegator must issue a fresh one. This is the architectural mechanism for "delegations don't live forever." (Revocation at the credential layer is a sibling mechanism documented in [`spec/credential-v1.md`](../../spec/credential-v1.md) §6, applied when credentials underlying a delegation are revoked.)
3. **Chain-traceable.** When agent A delegates to agent B, and B sub-delegates to C, the chain is a nested structure (`delegation_receipts` per §5.5) verifiable to a maximum depth of 10. Each hop is settled independently; per-hop fees are extracted; the audit trail terminates at the user's signed identity, not at a platform's auth root. This is the load-bearing semantic property the next section names.

## How motebit's delegation differs from OAuth / SSO

Every web-platform reader will map "delegation" to OAuth, SAML, OpenID Connect, SSO, or one of the dozens of API auth schemes that have shipped delegation primitives for the last decade. Without explicit contrast, that mapping obscures the moat.

The differentiator: **motebit's delegation is bound to the user's cryptographic identity, not to a platform issuer.**

| Property                 | OAuth / SSO / SAML / OIDC                      | Motebit delegation                                                         |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Auth root                | Platform's auth server                         | User's `MotebitId` keypair (Ed25519)                                       |
| Revocation               | Revocable by platform                          | Revocable by user (delegator owns the key)                                 |
| Chain termination        | At platform's auth root                        | At user's signed identity                                                  |
| Survives platform switch | No (delegation dies when user leaves platform) | Yes (delegation chain follows the user's identity)                         |
| Verification             | Requires contacting platform's auth server     | Independent — any third party with delegator's public key verifies offline |

The last row is the structurally-different shape. OAuth's verification requires the OAuth provider's auth server to be online and willing to attest. Motebit's verification requires only the delegator's Ed25519 public key and the receipt bytes — no network round-trip, no platform involvement, no platform-dependency. This is what makes delegations chains **portable**: they survive any vendor swap, any platform switch, any provider migration, because the verification root is the user's identity, not the platform's.

This is the moat in cryptographic form. Every closed-source AI platform's identity layer is OAuth-shaped (their auth server is the trust root). Motebit's identity layer is sovereign-shaped (the user's keypair is the trust root). The "delegation chains survive platform switches" property is what incumbents structurally can't replicate without dismantling their own business per [`protocol-primacy.md`](protocol-primacy.md). Naming this property in code (via the chain-traceable invariant) makes the moat concretely auditable; naming it in doctrine makes the moat communicable.

## Composition: each cross-cut is a structural binding

Delegation composes with the other five primitives via specific structural bindings, not generic "see also" references. Each binding is named explicitly because the connector claim depends on the bindings being concrete:

- **Delegation → Identity binding.** The delegator is identified by their Ed25519 public key; the `submitted_by` field in `AgentTask` (§3.1) is a `MotebitId` that resolves to that key. Without the identity binding, the delegation has no signer; without delegation, the identity binding produces no flow. The two define each other.

- **Delegation → Trust binding.** Trust accumulation runs through delegation outcomes — `AgentTrustRecord` in `@motebit/protocol` records `successful_tasks` / `failed_tasks` / `interaction_count` / `last_seen_at`, all keyed on delegation resolutions. `computeReputationScore` in `@motebit/policy` reads these fields. Without delegations, the trust graph has no inputs; without the trust graph, delegations have no track record. The two define each other.

- **Delegation → Receipts binding.** Every delegation produces a signed receipt — `ExecutionReceipt` for task-level resolution, `ToolInvocationReceipt` for per-tool granularity. Receipts are not generated by some separate audit-logging system; they are the **emission shape of delegation outcomes**. Per [`receipts-unified.md`](receipts-unified.md), the three receipt types are the three granularities of delegation attestation.

- **Delegation → Settlement binding.** "No receipt, no settlement" (§6.4 foundation law) — the receipt's Ed25519 signature must pass before any money moves. Settlement is not triggered by task completion; it is triggered by cryptographic proof of delegation resolution. This is what makes settlement self-attesting in the sense of [`self-attesting-system.md`](self-attesting-system.md) — money moves only when delegations close honestly.

- **Delegation → Protocol-primacy binding.** Delegation is protocol-level, never subscription-gated. Per [`protocol-primacy.md`](protocol-primacy.md)'s constitutional invariant, the audit "does this work identically for a user who never subscribes?" returns YES for every delegation primitive — `AgentTask` submission, `ExecutionReceipt` signing, the canonical capability vocabulary, the chain-traceable verification, the sovereign (relay-optional) path via [`spec/delegation-v1.md`](../../spec/delegation-v1.md) §8. The convenience tier may extend retention of delegation receipts within sensitivity ceilings; it cannot gate the existence of delegation.

The five bindings compose into one structural claim: **motebit's protocol layer IS the delegation layer.** Identity, trust, receipts, settlement, policy are the static surfaces; delegation is the dynamic relationship that runs through all five. This is why the doctrine memo for delegation deserves its place alongside the others — not because the positioning sentence has six concepts, but because delegation is the architectural relationship the other five primitives instantiate.

## Spec status

The wire spec [`spec/delegation-v1.md`](../../spec/delegation-v1.md) is currently **Draft** status. This doctrine memo governs the six invariants above (cryptographic + semantic) regardless of evolutions in the wire format. The spec details how the invariants are expressed on the wire; if a future spec revision changes a field name or normalization rule, the doctrine's invariants still hold and the spec is updated to match. Same deferral pattern as [`receipts-unified.md`](receipts-unified.md) — doctrine names the family; spec details the implementation.

When the spec graduates from Draft to Stable, this section reduces to a one-line "Stable per `delegation-v1.md`."

## Why "delegation" is the right tagline word

Three candidates were considered for the positioning sentence's third concept (alongside identity, trust, receipts, settlement):

- **"Permissions"** — consumer-shaped, broadly intelligible, but undersells the architecture. Maps mentally to "what an app is allowed to access" (ACL-shaped, static).
- **"Policy"** — technically accurate for the code surface (`@motebit/policy`, `PolicyGate`) but enterprise/legalistic. Reads as the constraint layer, not the relationship.
- **"Delegation"** — names the relational primitive that makes the architecture compose. Captures the cryptographically-verifiable, scope-bounded, time-bounded, chain-traceable, identity-rooted relationship that distinguishes motebit from OAuth-shaped platforms.

The corrected tagline candidate: _"Motebit lets AI agents act with identity, trust, **delegation**, receipts, and settlement. Open protocol. Managed cloud. Relay economy."_

The doctrine memo for "delegation" exists (this one), the spec for delegation exists (`delegation-v1.md`), the code surface for delegation exists (`packages/runtime/src/relay-delegation.ts`, `packages/runtime/src/interactive-delegation.ts`, `packages/runtime/src/agent-task-handler.ts`, `delegate_to_agent` tool, A2A federation delegation per [`services/relay/CLAUDE.md`](../../services/relay/CLAUDE.md) §7-9). When the tagline swaps "permissions" → "delegation," the word points at a doctrinal artifact that grounds it. Until the swap lands, this doctrine memo is the surface readers find when grepping for what "delegation" means in motebit's architecture.

A future cross-reference paragraph in the policy package's per-directory `CLAUDE.md` (when one ships) — _"policy covers what consumer-facing material calls 'delegation' (same concept, different audience precision; policy is the constraint layer of the delegation relationship)"_ — is the discoverability bridge written last, depending on this doctrine memo plus the tagline swap to be in place.

## Cross-cuts

- [`protocol-primacy.md`](protocol-primacy.md) — the constitutional invariant; delegation is protocol-level, never subscription-gated. The two doctrines compose into the moat: protocol-primacy names what motebit doesn't gate (the sovereign substrate); this doctrine names what motebit uniquely provides at the protocol layer (the delegation connector with OAuth-incompatible architectural shape).
- [`receipts-unified.md`](receipts-unified.md) — the three receipt types are the three granularities of delegation attestation. Every delegation produces a receipt; receipts are the emission shape of delegation outcomes.
- [`settlement-rails.md`](settlement-rails.md) — settlement is triggered by delegation-receipt verification, not by task completion. Custody split (guest vs sovereign rails) determines who holds the money during the delegation lifecycle.
- [`agility-as-role.md`](agility-as-role.md) — cryptosuite agility means delegation signatures evolve via registry append (PQ migration is a registry add, not a wire-format break for delegations).
- [`self-attesting-system.md`](self-attesting-system.md) — every claim is user-verifiable; delegation receipts are the verifier-facing artifacts that make every action on a user's behalf cryptographically auditable.
- [`docs/doctrine/audits/2026-05-13-positioning-architecture-audit.md`](audits/2026-05-13-positioning-architecture-audit.md) — the audit that surfaced this doctrine's need (asymmetry 1: permissions/policy vs delegation). This memo closes that asymmetry.
- [`spec/delegation-v1.md`](../../spec/delegation-v1.md) — Draft wire spec; foundation laws in §3.3, §4.2, §6.4 instantiate the semantic invariants above.
- [`services/relay/CLAUDE.md`](../../services/relay/CLAUDE.md) — rules 6 (relay is convenience-layer-not-trust-root) and 11 (receipts append-only byte-identical) apply directly to delegation receipts.
