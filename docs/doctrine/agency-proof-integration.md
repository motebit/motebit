# Agency proof integration — consume the floor, don't fork it

agency.computer is the first external consumer of the motebit proof floor, built repo-blind from the published packages alone. It is therefore the live **protocol-primacy conformance test**: "does the floor work identically for a non-subscriber?" — answered by an outsider being one. This document is the contract that integration codes against. Every clause points at a gate or a test, not at prose — lore is not an authority.

The discipline that produced it: **running beats reviewing.** Both the catches that mattered came from executing, not discussing — an outsider running the real verifier found the demo receipt verifies as `sovereign: false` (integrity-only), and going to build a "hex receipt" fixture found that no such valid artifact exists. Each clause below survived a run.

## 1. Consume, don't fork (hard NO)

`npm i @motebit/verifier`. Do **not** reimplement, extract, or fork a sibling verifier — not from a minified bundle, not "just the JCS part." Canonicalization (JCS / RFC 8785) and cryptosuite dispatch are where hand-rolled verifiers silently pass one receipt and fail the next; a sibling that drifts from the spec is the worst possible artifact for a proof brand. This is "don't roll your own crypto" one layer up. The package is Apache-2.0, zero monorepo deps, browser-safe. `receipt.computer` consumes the same package — that's why the cross-site interlock holds. Mirrors the package-layer-audit rule in the root `CLAUDE.md` ("protocol primitives belong in packages, never inline").

## 2. The public API agency may depend on, and the semver guarantee

The surface, and only this surface: `verifyArtifact`, `verifyFile`, `formatHuman`; types `VerifyResultWithBinding`, `VerifyResult`. **`scripts/check-api-surface.ts` enforces stability** — it extracts each permissive-floor package's API from the built `.d.ts` and fails CI on any undeclared break; a break is only accepted with a `major` changeset + migration guide. Pin the exact version (`@motebit/verifier@1.2.3` or later within the major) and the surface is contractually safe within that major. **This is the reciprocal obligation**: because agency is the on-camera proof the floor works for outsiders, the floor owes it API stability. Caveat: the gate softens to a warning while a `major` changeset is pending, so treat a major bump as a re-test signal, not a silent break.

## 3. Rung-field mapping (verified by running)

Integrity ≠ identity. Render the rung you actually verified:

- **Integrity** = `result.valid` (bytes intact, signed by the embedded key).
- **Identity rung** = `result.sovereign` (boolean). There is **no `binding` field**, and `keySource` stays `"embedded"` even when sovereign (the key is embedded _and_ committed-to). The "integrity-only / sovereign" prose exists only in `formatHuman`.

Honest-claim language, baked in so copy can't overclaim:

| `result.sovereign` | What it proves                                                                                             | What it does **not** prove                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`             | Signed by a key the `motebit_id` itself commits to, and unaltered — confirmed offline, no relay, no chain. | That this `motebit_id` is the _real_ agency. A forger can mint a self-consistent sovereign identity of their own — binding the id to the operator is a separate (anchored) step. |
| `false` (valid)    | Bytes intact, signed by the embedded key.                                                                  | _Whose_ key it is. Never present `valid: true` as identity.                                                                                                                      |

Underclaim on purpose. For a proof brand, one debunked claim is fatal; honesty is the moat.

## 4. Suite dispatch by artifact type — never hardcode a suite

ExecutionReceipts are signed under **`motebit-jcs-ed25519-b64-v1` only**; `verifyExecutionReceipt` rejects any other suite fail-closed. `motebit-jcs-ed25519-hex-v1` is the **identity-file** suite — so a "hex execution receipt" is a _negative_ fixture (correctly rejected), not a test vector. The silent-death risk for a receipt consumer is therefore **cross-artifact-type** (receipt = b64 vs identity-file = hex), not cross-receipt. Never decode by a hardcoded suite; route through the library, which dispatches on the artifact's own `suite` field (`@motebit/crypto` suite-dispatch). New PQ suites are a registry append, not a wire break.

## 5. Citation-grade failures

`formatHuman` renders the spec-section citation from `@motebit/crypto`'s receipt verification — `§11.2` (signature), `§11.3` (key resolution), `§11.5` (delegation) — matching the Python reference verifier (`examples/python-receipt-verifier`) string-for-string. A tampered receipt reports `§11.2 violation: Ed25519 signature did not verify` in both verifiers. Agency copy may quote these; the failure being citation-grade is the detail that sells the proof.

## 6. Anchored ≠ same-origin

The **anchored** rung pins the `motebit_id`→key binding against the _operator's_ relay transparency anchor (`/.well-known/motebit-transparency.json`, signed by `relay_public_key`). Its trust root is that **signature**, not the origin that serves it. A site serving its _own_ transparency declaration is self-attestation — a fancier self-signature, **not** anchored; the TLS padlock proves "you're on this domain," never "this signer is the real agent per the operator's log." On-page, agency renders **integrity + sovereign only** (both offline, both real). Anchored requires the real operator anchor; do not relabel a same-origin self-anchor as "anchored." (Same error class as treating a Solana lookup as the definition of anchored — see [`identity-binding-verification.md`](identity-binding-verification.md).)

## 7. Fixtures (ground truth, reachable, frozen)

Committed fixtures under `examples/python-receipt-verifier/fixtures/`, reachable by raw URL and linked from [`docs/developer/verify-a-receipt`](../../apps/docs/content/docs/developer/verify-a-receipt.mdx):

- `example-receipt.json` — integrity-only (`sovereign: false`).
- `sovereign-receipt.json` — `sovereign: true`; self-referential `result` (a verifier smoke test, not a product demo).
- `sovereign-receipt-stripe-audit.json`, `sovereign-receipt-email-approval.json` — `sovereign: true`, **outcome-shaped** (§11): the demo vectors a proof UI should ship.

All minted through the canonical `signExecutionReceipt` (never hand-rolled), reproducible via the committed `mint-*.mjs` generators with a fixed **public** demo key.

**Frozen-vector contract.** Published fixtures are immutable: never reformat or regenerate one in place — a changed receipt gets a new filename. Consumers byte-match them (`test:fixture-fresh`), so an in-place edit (even a prettier reflow) would silently red a consumer's CI. This reciprocal is what makes coupling a consumer's gate to the platform's serialization safe.

Deferred, explicitly, never faked: **pinned / anchored** fixtures need a real relay transparency anchor; the **hardware-suite** vector needs real device attestation. A faked hardware fixture in a proof brand is the worst artifact there is — ship "not yet" instead.

## 8. Definition of done = the offline tamper test

Phase 1 exists when, **with the network blocked**: the real sovereign fixture → `sovereign`-green, and one mutated byte → `§11.2` red. Encoded as a CI gate, not a screenshot. The demo is the spec.

## 9. The interlock is the shared floor, not a version string

The instinct to "pin the same `@motebit/verifier` version receipt.computer ships" is **wrong and unwireable** — receipt.computer is `@motebit/verify-web`, which verifies via `@motebit/state-export-client` (the full-ladder surface), not `@motebit/verifier` at all (§12). There is no shared verifier version to match. The real interlock lives one layer down: every surface verifies through `@motebit/crypto`'s JCS canonicalization + the fixed `motebit-jcs-ed25519-b64-v1` suite — guaranteed by the shared floor, not a version.

- **Consumer scope:** assert your committed fixture is byte-identical to the published canonical one (`test:fixture-fresh`) and verifies offline (`test:proof`). That is all a consumer can and should own.
- **Platform scope (motebit):** cross-implementation conformance — same fixture → same verdict across `@motebit/verifier`, the `state-export-client` path, and the Python reference — lives in this repo, where all three impls do. Never bolt a Python runtime onto a consumer's CI to re-prove a guarantee that isn't theirs.

## 10. agency stays an outsider — that's the experiment

Separate repo, public packages only, no insider access, no private imports. **Outsider friction is a logged bug in motebit's docs/packages, never a workaround.** The grade is a _cold_ run: a fresh agent, no briefing, given only `docs.motebit.com` + npm, must reach the offline tamper test (harness: `examples/third-party-integrator-eval`). We do not grade our own homework.

Trust tiers, by **how much of agency you must trust** — ship all three: on-page (agency's served JS) → receipt.computer (motebit's origin) → `npx @motebit/verify` (only npm + `@motebit/*`, not agency's page at all). The third tier — "don't even trust this page, run it yourself" — is the real floor.

## 11. Sign a receipt of work, not of math

A proof is only as compelling as the claim it secures. A receipt whose `result` describes its own verification ("this receipt was signed by a key…") proves a triviality — the visitor breaks the proof of _nothing they care about_, which _under-sells the very feature_ the proof exists to showcase. The demo vector must be a receipt of **recognizable work** — "audited 1,284 Stripe payouts, flagged 3 over $50, paused before export" — so the skeptic breaks the proof of _the thing they'd actually delegate_. The UI **leads with the act** (who / what / the policy pause — the `result`), with `sovereign` / `Ed25519 ✓` as the quiet trust line beneath, never the headline (`records-vs-acts`: the body shows the act; the crypto is the record that makes it trustworthy). This is honesty _and_ UX, not a trade — you don't choose between a real proof and a compelling one; you sign a real receipt of a compelling act. (How the pendulum overshot from "fake receipts of real outcomes" to "real receipts of math" is the cautionary tale that produced this clause.)

## 12. Which verify surface (the topology that beat everyone)

Three surfaces, all on the `@motebit/crypto` floor; pick by the deepest rung you need:

- `@motebit/crypto` — the primitive; never called from a UI.
- `@motebit/verifier` — **offline** (integrity → sovereign, `formatHuman`) → agency's surface and the CLI.
- `@motebit/state-export-client` — **full ladder** (adds pinned → anchored via the relay second channel) → receipt.computer's surface.

This composition is the one thing the public surface failed to make legible — it produced three independent misreads in this experiment (Solana = anchored, same-origin = anchored, receipt.computer = verifier), from both outside _and_ inside. The consumer-facing fix is [`docs/developer/choosing-a-verify-surface`](../../apps/docs/content/docs/developer/choosing-a-verify-surface.mdx). The anchored upgrade path is `verifier → state-export-client` (same family, no fork) — never a DIY same-origin trick (§6).
