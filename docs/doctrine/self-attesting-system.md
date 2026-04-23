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
3. **Comparison without trust.** Two self-attesting operators can be compared on their claims by a user who trusts neither. Sovereignty-preserving migration (`spec/migration-v1.md`) only has value if destinations can be compared before the user commits.
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

Self-attesting via code-is-public plus CI enforcement — verification is "clone this repository and run the check":

- Drift defenses (`scripts/check-*.ts` plus `scripts/check.ts` runner)
- Meta-probe (`scripts/check-gates-effective.ts` — attests every gate fires)
- License enforcement (`scripts/check-deps.ts` plus root `LICENSE` / `NOTICE` / `LICENSING.md` and per-package `LICENSE` files on the permissive floor)
- Cryptosuite compliance (`check-suite-declared`, `check-suite-dispatch`)
- Trust algorithm correctness (`@motebit/protocol` is Apache-2.0, deterministic; any implementation produces identical output from identical input)
- Custody split at the type level (`services/api/src/__tests__/custody-boundary.test.ts` — `@ts-expect-error` assertion)
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
