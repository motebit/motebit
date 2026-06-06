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

## 7. Fixtures (ground truth, reachable)

Two committed fixtures, one per shipped rung, both reachable by raw URL and linked from [`docs/developer/verify-a-receipt`](../../apps/docs/content/docs/developer/verify-a-receipt.mdx):

- `examples/python-receipt-verifier/fixtures/sovereign-receipt.json` — `sovereign: true`, minted through the canonical `signExecutionReceipt` (never hand-rolled), reproducible via `mint-sovereign-fixture.mjs` with a fixed **public** demo key.
- `examples/python-receipt-verifier/fixtures/example-receipt.json` — integrity-only (`sovereign: false`).

Deferred, explicitly, never faked: **pinned / anchored** fixtures need a real relay transparency anchor to sign against; the **hardware-suite** vector needs real device attestation. A faked hardware fixture in a proof brand is the worst artifact there is — ship "not yet" instead.

## 8. Definition of done = the offline tamper test

Phase 1 exists when, **with the network blocked**: the real sovereign fixture → `sovereign`-green, and one mutated byte → `§11.2` red. Encoded as a CI gate, not a screenshot. The demo is the spec.

## 9. Version parity with receipt.computer

Agency pins the exact `@motebit/verifier` version `receipt.computer` ships, with a CI assertion that they match. "Same engine, byte-for-byte interlock" must be enforced, not asserted in prose (Hyrum's Law: the moment the versions drift, the interlock silently dies).

## 10. agency stays an outsider — that's the experiment

Separate repo, public packages only, no insider access, no private imports. **Outsider friction is a logged bug in motebit's docs/packages, never a workaround.** The grade is a _cold_ run: a fresh agent, no briefing, given only `docs.motebit.com` + npm, must reach the offline tamper test (harness: `examples/third-party-integrator-eval`). We do not grade our own homework.

Trust tiers, by **how much of agency you must trust** — ship all three: on-page (agency's served JS) → receipt.computer (motebit's origin, same package) → `npx @motebit/verify` (only npm + `@motebit/*`, not agency's page at all). The third tier — "don't even trust this page, run it yourself" — is the real floor.
