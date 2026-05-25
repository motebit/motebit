# Self-attesting system

A motebit primitive makes a claim about something in the world — an identity file says _"this motebit_id is controlled by this key,"_ an execution receipt says _"this agent did this work,"_ a credential says _"this issuer attests this capability about this subject."_ Every such claim is signed by the party making it, verifiable by any third party, and requires no trust in the system that emitted it. When the system extends the same pattern to claims it makes about itself, it is **self-attesting**.

The pattern was not invented in this repo; it was named here. Every primitive motebit has ever shipped clears the three tests below by design. The name exists so future design decisions can be checked against the bar on purpose rather than by accident.

## The three-test check

A claim is self-attested only if all three hold:

1. **The claim is a structured artifact** — signed JSON, onchain commitment, cryptographic receipt. Not English prose. Not a blog post. Not a transparency report PDF.
2. **Verification requires no trust** in the system making the claim. A third party with only public materials can check whether it is true.
3. **Verification uses the same mechanisms the system already provides to users** — `@motebit/crypto`, the Solana Memo anchor registry, canonical JSON hashing, the suite dispatcher. Not a privileged audit channel. Not a side-agreement.

A system is self-attesting when every claim it makes about itself clears these three tests.

## What it is not

- **Self-hosting** — the tool builds itself (a compiler compiling its own source). Concerns how the tool is built, not what it claims.
- **Meta-circular** — an interpreter written in the language it interprets. Concerns expressiveness, not attestation.
- **Reflection** — a program examining itself at runtime. Concerns introspection. Nothing is cryptographically verified.
- **Dogfooding** — the operator uses their own product. Concerns product validation. No cryptographic claims.
- **Transparency report** — periodic disclosure of operator practices. Structured but not self-attesting unless signed and verifiable. Most such reports are PDFs, which fail test 2.

Self-attesting is the narrower pattern: the system provides both the claim _and_ the mechanism to verify the claim, and it is the same mechanism it provides to users.

## Why it matters

Four compounding effects make this worth naming as doctrine:

1. **Forcing function for honesty.** A self-attested claim cannot silently lie. Signing _"this relay does not retain X"_ while retaining X makes the lie provable the moment it is discovered. Claims get honest by construction, not by legal exposure.
2. **Substitutes cryptography for courts.** Trust-based systems rely on lawsuits to enforce claims. Self-attesting systems rely on mathematics. Cryptography scales; legal enforcement does not (jurisdictional gaps, cost asymmetries, statute-of-limitations, forum shopping).
3. **Comparison without trust.** Two self-attesting operators can be compared on their claims by a user who trusts neither. Sovereignty-preserving migration (`spec/migration-v1.md`) only has value if destinations can be compared before the user commits. Runnable end-to-end — an agent picks up its identity + reputation and walks from one relay to another, the destination verifying the source's signature against a pinned key and trusting neither party: `pnpm demo-migration` (`scripts/demo-migration.ts`), built on `performMigration` from `@motebit/runtime`. Proven against deployed relays over the real internet (`pnpm migrate-live`, 2026-05-24) — a single-operator staging proof, honest perimeter documented in `docs/proofs/live-sovereign-migration.md`.
4. **Operator-Byzantine-tolerant.** Once a claim is anchored (signed + public record), even a compromised or malicious operator cannot retroactively erase it. Past claims survive the operator's continued existence — the disappearance test made precise.

## Where it is exhibited in motebit

Fully self-attesting artifacts — signed and offline-verifiable with only `@motebit/crypto` and public materials:

- `motebit.md` identity files (`spec/identity-v1.md`)
- Execution receipts (`spec/execution-ledger-v1.md`)
- Credentials — W3C VC 2.0 (`spec/credential-v1.md`)
- Credential anchors (`spec/credential-anchor-v1.md`) — Merkle batch + Solana Memo
- Revocation anchors — individual Solana Memo, `motebit:revocation:v1:...`
- Succession records — dual-signed key rotation (`spec/identity-v1.md §3.8`)
- Settlement receipts (`spec/settlement-v1.md`)
- Settlement proofs — onchain tx hashes in `relay_settlement_proofs`
- Federation handshake and heartbeat (`spec/relay-federation-v1.md`)
- Discovery metadata at `/.well-known/motebit.json` (`spec/discovery-v1.md`)
- Operator transparency declaration at `/.well-known/motebit-transparency.json` (`docs/doctrine/operator-transparency.md`)
- Content-artifact manifests on every state-export endpoint — relay-asserted `X-Motebit-Content-Manifest` HTTP header (`docs/doctrine/nist-alignment.md` §8). Verified offline with `motebit-verify content-artifact <body> --manifest <header>` against the relay public key from the operator-transparency declaration.

The canonical verifier closes the consumer side: `packages/verify/src/cli.ts` (`motebit-verify`) accepts every signed-artifact category above (identity files, receipts, credentials, presentations, skills, content-artifact manifests) under one Apache-2.0 CLI. A claim is self-attesting only if a third party can verify it; a verifier that exists and demands the signature is what makes producer-side signing more than ceremony.

Verification must reach the **product surface**, not only the diagnostic tools. The CLI (`motebit-verify`) and `apps/inspector` verify state-export responses — but the surface that matters most is the one where the user reads their _own_ sovereign state. The sovereign panel's relay ledger fetch (`/api/v1/goals/…`, a signed state-export family) routes through an adapter-supplied `verifiedFetch` (`@motebit/state-export-client`'s `verifiedStateExportFetch` + TOFU transparency anchor) and renders a verification badge on the Ledger tab — so the relay cannot equivocate about a user's own ledger undetected, and the user _sees_ it was verified, not merely trusted. Verification is adapter-supplied (the zero-dep BSL controller delegates; each surface adapter holds the verifier import), shipped across all three flat surfaces — web, desktop, mobile — in one pass (2026-05-23). Drift-gated by `check-state-export-consumer-verifies`.

Self-attesting via code-is-public plus CI enforcement — verification is "clone this repository and run the check":

- Drift defenses (`scripts/check-*.ts` plus `scripts/check.ts` runner)
- **Signed-artifact ⇒ verifier** (`scripts/check-signed-artifact-verifiers.ts`) — the invariant that makes "a claim is self-attesting only if a third party can verify it" structural, not aspirational. Every signed `@motebit/protocol` wire type must be classified as having a portable verifier, being verified within a parent, or an explicitly-enumerated gap; a new signed artifact cannot ship without a verifier or a tracked-gap decision. The initial sweep surfaced 11 existing gaps — now a visible backlog rather than invisible truth, since a third party cannot self-verify those with the verification packages alone. The migration family closed first (2026-05-24): building its verifiers surfaced that the relay signed hex while its own published schema declared base64url, so the fix was both the verifiers and the encoding correction. `RelayMetadata` followed — and closing it hardened a live trust gap: `accept-migration` had verified a migration token against the source relay's key while fetching that key from an _unverified_ well-known endpoint, so it now establishes the key from a pinned federation peer or a verified `RelayMetadata`, fail-closed. A verifier _existing_ is not the same as a consumer _calling_ it: the same `accept-migration` route schema-validated and then ignored the agent's `CredentialBundle` signature — a stolen `MigrationToken` (`spec/migration-v1.md §13`) presented under a thief's key would have onboarded the victim's `motebit_id` under the attacker's key. Closed 2026-05-24 per §8.2 steps 4 + 6: the route now binds the presented key to the `motebit_id` (`verifySovereignBinding` — the id _is_ the commitment to the key, so a substituted key fails) and verifies the agent-signed bundle against that bound key (`verifyCredentialBundle`), both fail-closed. The end-to-end proof (`pnpm demo-migration`) now exercises a sovereign agent so the binding is part of the demonstration. Rotated-key binding via a transmitted `identity_file` succession chain (the other half of §8.2 step 6, `verifyKeyBindingAtTime`) is the deferred next tier — untestable end-to-end until `performMigration` carries the identity file. This require-but-not-verify class is gate #107's blind spot (a type-existence check cannot see a call site), so it is closed by a dedicated consumer-call gate immediately below; regression-locked meanwhile by three adversarial `accept-migration` tests (tamper / token-theft / id-mismatch). 5 verifier-existence gaps remain (settlement anchors, federation vote/proposal, solvency proofs).
- **Signed-artifact ⇒ verifier is _called_** (`scripts/check-signed-artifact-consumed-verified.ts`, #108) — the consumer-call complement to #107. #107 proves a portable verifier _exists_; this proves the relay _calls_ it on every inbound signed artifact it consumes, not merely schema-parses the body. This is the `check-wire-schema-usage` (#87) relationship one layer up: #22/#87 pin that wire schemas exist and are parsed (shape); #107/#108 pin that signature verifiers exist and are called (authenticity) — parse checks shape, verify checks authenticity, neither substitutes for the other. Two rules: import-and-call parity over #107's exported artifact-verifier `REGISTRY` (re-exports excluded), plus a required-usage manifest of the audited inbound consumers. Built from a relay-wide audit of every inbound signed-artifact consumer (the sibling-boundary rule applied to the `CredentialBundle` fix) — which confirmed that fix was the only instance of the class.
- Meta-probe (`scripts/check-gates-effective.ts` — attests every gate fires)
- License enforcement (`scripts/check-deps.ts` plus root `LICENSE` / `NOTICE` / `LICENSING.md` and per-package `LICENSE` files on the permissive floor)
- Cryptosuite compliance (`check-suite-declared`, `check-suite-dispatch`)
- Trust algorithm correctness (`@motebit/protocol` is Apache-2.0, deterministic; any implementation produces identical output from identical input)
- Custody split at the type level (`packages/settlement-rails/src/__tests__/custody-boundary.test.ts` — `@ts-expect-error` assertion)
- Spatial expression doctrine (`apps/spatial/src/__tests__/spatial-expression.neg.test.ts`)

## How to apply the principle

This doctrine is a review lens, not a CI gate. The fold lives in intent, not in a file-shape check.

When a new feature, spec, doctrine document, or claim about the relay's behavior is proposed, ask:

1. Does this make a claim?
2. Is the claim a structured artifact?
3. Can a third party verify it without trusting us?
4. Does verification use the same mechanisms we already provide to users?

If yes to all four, the claim is self-attested. If no to any, either the claim needs to be structured into a verifiable form, or the system has quietly asked for trust instead of providing proof. Either is worth naming in review.

Design decisions that tempt "trust us" framing almost always have a self-attesting alternative the doctrine points at. _Third-party analytics with content access_ is not self-attesting — the operator cannot prove the processor's behavior. _A signed declaration naming every processor and their data rights_ is self-attesting — the operator's relationship with each processor is a claim anyone can verify. The doctrine makes the lazy choice visible before it ships.

## Cross-references

- `docs/doctrine/operator-transparency.md` — the most recent application, extending self-attestation to the operator's own posture.
- `docs/doctrine/protocol-model.md` — the three-layer permissive-floor / BSL / accumulated-state model; self-attestation rides the permissive-floor primitive surface.
- `docs/doctrine/security-boundaries.md` — sensitivity gating and cryptographic primitives this pattern depends on.
- `docs/drift-defenses.md` — code-is-public self-attestation is how every drift gate works.
- `docs/doctrine/readme-as-glass.md` — related recursive-fold principle: the README's form mirrors the artifact's form.
