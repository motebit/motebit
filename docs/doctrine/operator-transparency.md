# Operator transparency

A motebit relay is the one place in the system that sees more than the user does. The user's identity is sovereign; the user's content is sensitivity-gated; but the operator that runs the relay sees presence (who exists), operational activity (who delegates to whom, who settles, who federates), and the structure of the network. That asymmetry is unavoidable — someone has to run the wires.

The motebit posture is to make that asymmetry **legible and verifiable** rather than asking users to trust it. An operator's observability is published as a signed artifact, anchored onchain like every other claim the relay makes, and structured the same way `motebit.md` and `credential-anchor-v1` are: cryptographic commitments anyone can verify offline.

This document defines the model. `spec/relay-transparency-v1.md` (when it lands) will define the wire format.

## The three-layer model

Every motebit relay has three layers of observability. Each layer answers a different question and warrants different treatment.

| Layer           | Observable                                                                                                    | Why                                                                                                                                                                                                | Off-limits                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Presence**    | `motebit_id`, public key, registration time, heartbeat, device count, federation peers                        | Required for sync — the relay is the only place that can tell devices about each other. See `docs/doctrine/protocol-model.md` § "Sync is the floor of legitimate centralization."                  | Real names, emails, phone numbers — never collected.                        |
| **Operational** | Delegation requests, signed receipts, settlements, credentials issued, capability listings, trust transitions | Required for economic correctness, audit, dispute, and routing. Every artifact at this layer is signed by the agent itself.                                                                        | Cross-agent correlation beyond what the trust algebra requires.             |
| **Content**     | Memory text, AI provider queries, sensitive artifact bodies                                                   | None — content is gated at the boundary by `packages/privacy-layer`. Medical/financial/secret memories never cross the surface. AI provider queries pass through proxy with no relay-side storage. | Anything in this row should be considered an attack surface, not a feature. |

## Why "declared" isn't enough

Sovereignty products have historically taken one of two postures:

1. **"Trust us, here's our policy"** — Signal, iCloud, most consumer E2EE. Privacy declared as text. Enforcement by reputation and legal exposure. Operators ask users to trust them.
2. **"Trust no one, run it yourself"** — self-hosted Matrix, self-hosted everything. Trust shifts entirely to the user. Operational complexity becomes the cost of sovereignty.

Motebit's third posture: **operators prove their posture using the primitives the protocol already requires.** Ed25519 signing, canonical JSON, Solana Memo anchoring, offline verification — these are not new infrastructure for transparency. They are already in use for identity, credentials, and settlement. Operator transparency rides the same rail as every other motebit claim.

The disappearance test applies as it always does: if the operator vanishes, every transparency claim it ever published survives onchain. Anyone holding a motebit cache can verify what the relay claimed about itself, including past versions of the claim, against an immutable record. No legal document is required to enforce it.

## What an operator publishes

Until `spec/relay-transparency-v1.md` lands, the recommended convention is two paired artifacts:

- A top-level `PRIVACY.md` declaring observability per layer in plain language.
- A signed JSON declaration at `/.well-known/motebit-transparency.json`.

The signed declaration is canonical; the markdown is human-readable. Disagreement between the two is a violation — they must be derived from the same source.

A transparency declaration should specify, at minimum:

- **Per-layer retention.** How long presence and operational data are retained, with an explicit statement that content is not retained.
- **IP handling.** Transient (rate-limit-only), short-term (logged for `N` days), or persistent (declare retention window and purpose).
- **Third-party processors.** Every external service the relay uses — analytics, AI providers, settlement rails, error tracking — named explicitly, with the data each receives.
- **Jurisdiction.** The legal authority the operator is subject to, including any data-disclosure framework that could compel content access.
- **Signature.** Ed25519 over the canonical JSON, suite-tagged per `docs/doctrine/protocol-model.md` § "Cryptosuite agility."
- **Onchain anchor** _(optional today, expected to become required in the wire-format spec)._ Solana Memo of the declaration's hash, so historical versions are independently auditable.

A user reads the declaration; a verifier checks the signature; a long-term auditor walks the chain. Three layers of trust scaffolding for one artifact.

## Anti-patterns

Every operator transparency posture is a no-op if any of these slip in:

- **Third-party analytics with content access.** Google Analytics, Mixpanel, Amplitude, Segment, Hotjar — all of these require granting an external processor data rights that violate the operator's own posture. Use privacy-respecting alternatives (Plausible, Umami, self-hosted) or none.
- **Vague retention.** _"We may retain data for up to 90 days where required"_ is unverifiable. Either the relay anchors a signed retention claim with a definite window or the claim does not exist.
- **Silent IP logging.** Most server frameworks log IPs by default. A declaration of "transient" must mean the log is provably not retained beyond the rate-limit window — verifiable by source review or by the absence of an IP-keyed table in the relay schema.
- **Unsigned declarations.** A markdown `PRIVACY.md` without a signed JSON twin is a legal document, not a verifiable one. Both layers must exist.
- **Operator-side memory inspection.** The relay must never read content. If a debug path exists that lets the operator decrypt or read user memory, that path is a violation regardless of intent — sovereignty cannot tolerate intentional backdoors.
- **Federation leakage.** Cross-relay routing must respect the source relay's transparency posture; federation cannot be a side channel that exposes content the source relay swore not to retain.
- **Retroactive silent revision.** Updating the published declaration without a signed succession record (and without anchoring the new version onchain) breaks the verifiability invariant. Updates are first-class signed artifacts, not silent edits.

## What a user can do with this

The asset of this doctrine is not the operator. It is the **user's ability to compare**.

- A user choosing between motebit-compatible relays reads each one's signed declaration.
- A migrator (`spec/migration-v1.md`) verifies that the destination's posture is at least as strict as the current relay's before transferring identity.
- A user concerned about a specific operator can check the chain anchor for the historical version of the declaration as of any past date — preventing silent retroactive changes.
- An auditor or journalist can compare declarations across operators without negotiating access; everything is signed and public.

This is why operator transparency is a protocol asset and not an operator-specific asset. The mechanism generalizes; the user value compounds with the size of the operator ecosystem.

## The disappearance test for posture

Every other layer of motebit passes a disappearance test: if the operator vanishes, identity files, execution receipts, credential anchors, settlement receipts, and revocation memos all remain verifiable using only `@motebit/crypto` and the chain. Operator transparency must clear the same bar.

A signed declaration that lives only on the operator's webserver fails the test the moment the operator deletes it. A signed declaration anchored onchain passes — the hash is permanently recorded; any holder of the original JSON can prove it was the operator's claim at a specific time. The optional anchor in the convention above becomes mandatory in the wire-format spec for exactly this reason.

## Staged path

**Stage 1 — this document.** The doctrine. Operators read it and structure their posture accordingly. No new code, no new spec, no wire format committed yet.

**Stage 2 — split into three independent closures.** The original conflation was a doctrine drift: "wire-format spec," "onchain anchor," and "operator-comparison vocabulary" were bundled under one trigger ("second operator"), but they answer different questions and clear different gaps. The savant-gap critique surfaced the first split (2a from 2b); examining 2b under the same lens surfaced a second split (2b-i from 2b-ii). Each lands when ITS own trigger fires:

- **Stage 2a — onchain anchor (shipped 2026-05-11).** The relay anchors `sha256(canonicalJson(declaration))` to Solana via the Memo program (`motebit:transparency:v1:{hash}` format) at startup whenever `SOLANA_RPC_URL` is configured. Closes the trust-on-first-use savant gap: a verifier with the relay's pinned anchor address (`@motebit/state-export-client::lookupTransparencyAnchor`) cross-checks the declaration's hash against the onchain memo. Without this, the first fetch of `/.well-known/motebit-transparency.json` trusts HTTPS + DNS + CAs — a DNS hijack, malicious ISP, or compromised CA could substitute a different declaration whose self-signature verifies (against the attacker's key). With this, the verifier trusts a separate channel (Solana) that the network provider cannot tamper with. Drift-locked by `check-transparency-onchain-anchored` (drift-defense #88). Lifted forward from the deferred bucket because the trigger ("second operator") and the trust-anchor closure are architecturally independent — single-operator deployments benefit from the anchor immediately. Doctrine: `docs/doctrine/nist-alignment.md` §8 "savant gap closure".
- **Stage 2b-i — `spec/relay-transparency-v1.md` (shipped 2026-05-11).** The trust-anchor primitive's wire-format spec — `SignedTransparencyDeclaration` envelope shape, hash derivation (`canonicalJson` of the signed payload sans signature), pinned cryptosuite `motebit-jcs-ed25519-hex-v1`, onchain anchor memo format (`motebit:transparency:v1:{hash}` — codifies what 2a shipped), succession rules (refer to `spec/identity-v1.md` §3.8), verification algorithm. The `content` field is operator-extensible per §3.1; the protocol commits to the envelope, not the posture vocabulary inside. Lifted forward because the **trigger was "trust-anchor codification," not "multi-operator field standardization"** — the original deferral conflated them. After commit 605d288b made `transparency.json` load-bearing as the trust anchor for state-export verification, the asymmetry between transparency (no spec) and every other trust anchor in motebit (specs) became the gap to close. Wire types in `@motebit/protocol::SignedTransparencyDeclaration`; zod schema in `@motebit/wire-schemas`; reference implementation in `services/relay/src/transparency.ts` consumes the canonical types. Drift-locked by `check-spec-coverage` + `check-spec-wire-schemas` (existing gates extend automatically).
- **Stage 2b-ii — operator-comparison vocabulary (still deferred).** `content` field standardization: retention-window encoding, processor schema, jurisdiction format, comparable posture diff shape. Lands once a second motebit-compatible operator forces the question of _"what fields must we standardize?"_ Codifying before then would be guessing rather than observing. Operators today populate `content` per their own posture; the reference relay's `DECLARATION_CONTENT` shape (`services/relay/src/transparency.ts`) is convention, not protocol. Verifiers MUST NOT reject declarations on `content` shape difference — only on envelope failure (per `spec/relay-transparency-v1.md` §3.1).

**Stage 3 — ecosystem.** Comparison UIs, CLI commands (`motebit compare-relays`), migration nudges that diff transparency postures, periodic transparency reports published as protocol artifacts rather than legal documents. Lands when there are at least two declarations to compare AND Stage 2b-ii has standardized the comparable fields.

Same staged shape as the rest of motebit: doctrine first, spec when generalization is observed, ecosystem when comparison has value.

## Reference implementation

Stage 1.5 of this doctrine is live in the canonical relay:

- **Source of truth:** `services/relay/src/transparency.ts` — `DECLARATION_CONTENT` is the single object both artifacts derive from.
- **Human-readable:** [`services/relay/PRIVACY.md`](../../services/relay/PRIVACY.md) — committed to the repo, generated from the renderer.
- **Machine-verifiable:** `GET /.well-known/motebit-transparency.json` — Ed25519-signed under `motebit-jcs-ed25519-hex-v1`, suite-tagged for the dispatcher in `@motebit/crypto`.
- **Operator view:** `GET /api/v1/admin/transparency` — same declaration plus the onchain-anchor placeholder showing the disappearance-test gap that closes when stage 2 lands. Master-token gated (operator-internal); the public-facing artifact is the signed `/.well-known/` JSON above.
- **Sibling-boundary defense:** `services/relay/src/__tests__/transparency.test.ts` asserts `PRIVACY.md` matches `renderMarkdown()` exactly. Drift between the two artifacts breaks the build.
- **Trust-anchor for content-artifact verification.** The `relay_public_key` embedded in the signed declaration is the canonical trust anchor a third party uses to verify any state-export manifest the relay emits (see `docs/doctrine/nist-alignment.md` §8). Chain: fetch `/.well-known/motebit-transparency.json` → verify its self-signature against the embedded `relay_public_key` (one round-trip, offline-after-first-fetch) → use that key to verify every `X-Motebit-Content-Manifest` HTTP header on subsequent state-export reads. `motebit-verify content-artifact <body> --producer-key <hex>` consumes this chain. The transparency declaration is no longer just the operator's posture statement — it is the trust anchor for the operator's signed assembly of every export it produces.

The implementation deliberately stops at stage 1.5: it satisfies the _signed declaration_ and _user-readable form_ halves of the doctrine, and explicitly admits in its own `honest_gaps` field that onchain anchoring lands with stage 2. That admission is the defense against forgetting to close the gap.

## Cross-references

- `docs/doctrine/protocol-model.md` — three-layer model (protocol / reference / state) and the operational test that this doctrine extends to the operator surface.
- `docs/doctrine/security-boundaries.md` — sensitivity gating at the content boundary that makes layer 3 ("none observed") enforceable.
- `docs/doctrine/settlement-rails.md` — same pattern of _"operator declares; user verifies"_ applied to value movement.
- `spec/credential-anchor-v1.md` — the technical pattern (sign + Merkle batch + Solana Memo + 4-step verification) the future transparency spec will follow.
- `spec/discovery-v1.md` — `/.well-known/motebit.json` precedent for relay-published signed metadata; transparency adds a sibling well-known endpoint.
- `spec/migration-v1.md` — transparency declarations become inputs to the migration decision; the destination's posture is verifiable before the user commits.
