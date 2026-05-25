# @motebit/state-export-client

## 0.3.1

### Patch Changes

- Updated dependencies [9633741]
- Updated dependencies [becd049]
- Updated dependencies [0d031b9]
- Updated dependencies [8ee9db6]
- Updated dependencies [e1274cb]
- Updated dependencies [4629ac9]
- Updated dependencies [b296474]
- Updated dependencies [d905fea]
  - @motebit/crypto@2.1.0
  - @motebit/protocol@2.0.1

## 0.3.0

### Minor Changes

- 964f98a: Add `lookupKeyRevocation` and the `revoked` binding rung. A verifier can now scan the relay's pinned Solana address for a `motebit:revocation:v1:{key}:{timestamp}` memo and, via `verifyReceiptDocument`'s new `revocation` option, refuse to bind a receipt whose signing key was revoked at or before the receipt's timestamp — `binding: "revoked"` overrides every other rung. Revocation is read from the neutral chain, never the relay's `/identity` response, because a relay could hide a revocation that protects a key it controls.
- ecc15f3: Receipt verification now structurally separates signature integrity from identity binding.

  A verified signature proves the embedded key signed the receipt bytes; it does NOT prove that key belongs to the receipt's `motebit_id` — a forged receipt can embed any key and still verify. The result types now make that distinction unmistakable:
  - `ReceiptVerifyResult` and `ReceiptVerification` carry a `keySource` field. `verifyReceiptChain` records whether the verifying key was resolved from the caller's trusted `knownKeys` map (`"external"` — identity binding established) or fell back to the receipt's own embedded `public_key` (`"embedded"` — byte-integrity only). `verifyReceipt` is always `"embedded"`.
  - The browser inner-receipt verifier surfaces `identityBinding: "embedded-key-unverified"` on successful checks, so a UI never renders "from \<motebit\>" on the strength of an envelope-asserted key alone.

  Callers MUST gate identity claims on `keySource === "external"` (or an external transparency/known-keys anchor). Additive and backward-compatible — callers that ignore the new fields are unaffected.

- 421dafd: Add the sovereign binding rung. `deriveSovereignMotebitId(genesisKey)` derives a UUIDv8 commitment from `sha256(genesisKey)`, and `verifySovereignBinding(motebitId, genesisKey)` checks it — so a sovereign-minted motebit's `motebit_id` IS the commitment to its genesis key, verifiable offline with no operator. `verifyKeyBindingAtTime` now reports `sovereign: true` on its result, and `verifyReceiptDocument` reaches `binding: "sovereign"` (the strongest rung, needing only the identity file — no anchor, no relay, no chain). The genesis key derives from a 32-byte seed, so sovereign ids are recoverable and rotation still works via succession. Additive: sovereign ids are UUIDv8, existing ids are UUIDv7, so they never collide; minting sovereign ids is opt-in.
- 6dedf51: `verifyReceiptDocument` now accepts an optional `identity` (the producing motebit's identity file) and upgrades the result to the `"pinned"` binding rung when the receipt's signing key is time-valid for that identity's succession chain and the `motebit_id` matches. The binding status is now a trust-minimization ladder — `unverified` / `integrity-only` / `pinned` — replacing the placeholder `"bound"` with the rung vocabulary from `docs/doctrine/identity-binding-verification.md`. Composes `@motebit/crypto`'s `verifyKeyBindingAtTime`; the `anchored` and `sovereign` rungs layer operator non-equivocation on top in later slices.
- c84d13a: Add `verifyReceiptDocument` — verify a pasted or standalone `ExecutionReceipt` entirely offline and project it into an honest, display-ready view model that keeps signature **integrity** separate from identity **binding** (the brain behind a public receipt verifier). A valid offline check is `integrity-only` — it never claims the key belongs to the `motebit_id`; the `"bound"` status is reserved for a future trusted-anchor path. Malformed or non-receipt input surfaces typed reasons (`malformed_json` / `not_a_receipt` / `signature_invalid` / `missing_public_key` / `delegation_failed`) rather than throwing. Composes `@motebit/crypto`'s `verifyReceipt`; no new cryptography.

### Patch Changes

- Updated dependencies [b0d068b]
- Updated dependencies [92c2800]
- Updated dependencies [6a46f33]
- Updated dependencies [02d09da]
- Updated dependencies [de086d7]
- Updated dependencies [31ceae3]
- Updated dependencies [1a7201c]
- Updated dependencies [e4389bc]
- Updated dependencies [53e11b5]
- Updated dependencies [2428248]
- Updated dependencies [1c90c5d]
- Updated dependencies [f1d3308]
- Updated dependencies [a5abc51]
- Updated dependencies [904d744]
- Updated dependencies [91b582e]
- Updated dependencies [4ea0127]
- Updated dependencies [46189c6]
- Updated dependencies [00585fc]
- Updated dependencies [ecc15f3]
- Updated dependencies [7dd54da]
- Updated dependencies [44e55f0]
- Updated dependencies [be9275a]
- Updated dependencies [343e81f]
- Updated dependencies [8262902]
- Updated dependencies [421dafd]
  - @motebit/protocol@2.0.0
  - @motebit/crypto@2.0.0

## 0.2.0

### Minor Changes

- 4bb65d8: Ship the consumer side of v1.1 inner-receipt recursive verification. Closes the producer-consumer arc the previous commit opened — the v1.1 wire change is no longer invisible truth, every shipping verifier now demands the inner signatures.

  **`@motebit/crypto`** — `verifyReceipt` is now publicly exported (was internal-only). Verifies a single `ExecutionReceipt`'s Ed25519 signature against its embedded `public_key` and walks `delegation_receipts` recursively for multi-hop chains. Returns the standard `ReceiptVerifyResult` shape used elsewhere in the package.

  **`@motebit/state-export-client`** — new export `verifyInnerSignedReceipts(body)`:

  ```ts
  import { verifyInnerSignedReceipts } from "@motebit/state-export-client";

  const result = await verifyInnerSignedReceipts(body);
  if (result.applicable) {
    console.log(`${result.verifiedCount}/${result.totalCount} inner receipts verified`);
    for (const r of result.results) {
      if (!r.valid) console.error(`✗ ${r.taskId} (${r.motebitId}): ${r.reason}`);
    }
  }
  ```

  Parses each entry in `signed_receipts: string[]` as an `ExecutionReceipt`, calls `verifyReceipt`, returns a per-receipt verdict. Detects v1.1 bodies by checking `spec === "motebit/execution-ledger@1.1"` plus a non-empty `signed_receipts` field; returns `applicable: false` for v1.0 bodies, non-execution-ledger bodies, and non-object input. Five typed failure reasons: `malformed_json`, `missing_public_key`, `signature_invalid`, `delegation_failed`, `unknown`. Browser-safe — same dep boundary as the rest of the package.

  **`@motebit/verify`** — `motebit-verify content-artifact` auto-invokes the recursive verifier whenever the manifest's `artifact_type === "execution-ledger"` and the body declares v1.1. No flag required (calm-software default — silent when the field doesn't apply). Per-receipt outcomes surface in both human output and `--json` output. Exit code now gates on outer AND inner — a v1.1 bundle where any inner receipt fails (`signature_invalid`, etc.) fails the overall verification even when the relay's outer signature is valid: the relay is correctly attesting bytes it assembled, but those bytes contain falsified inner claims.

  **Why this matters:** the v1.1 producer commit shipped byte-identical inner receipts into a void — no consumer recursively verified. Today, every motebit-verify run audits inner signatures end-to-end. A federation peer with the relay's transparency-pinned key + a cross-relay state-export + `motebit-verify` can audit every motebit's claim inside without trusting the relay or any intermediary. Cross-relay verification becomes operationally complete, not just structurally possible.

  Drift-locked by `check-execution-ledger-inner-receipt-verified` (drift-defense #90): the gate scans the state-export-client primitive home, the package re-export, and the CLI's import + call site; a refactor that disconnects the consumer-side wiring fails CI.

  Doctrine: `spec/execution-ledger-v1.md` §4.3; `docs/doctrine/nist-alignment.md` §8 "Inner-receipt verifier shipped 2026-05-12."

- cf41fff: Publish-surface README audit — every public package now documents every named value export.

  The triggering incident: `@motebit/state-export-client@0.2.0` (the inner-receipt recursive verifier release) shipped `verifyInnerSignedReceipts` as a new public export, but the README still described only the prior surface. A consumer landing on the npm page wouldn't have discovered the new function. Audit across the publish surface revealed the same code-shaped-prose-drift shape in five other packages — each with a small set of legitimate but undocumented exports.

  **`@motebit/state-export-client`**: README rewritten — quick-start now covers both the outer-envelope path (`verifiedStateExportFetch`) and the inner-receipt path (`verifyInnerSignedReceipts`); programmatic-surface table lists every named export with its role; failure-reasons section covers outer + inner; onchain-anchor consumers (`lookupTransparencyAnchor`, `verifyDeclarationOnchainAnchor`) are documented.

  **`@motebit/verify`**: README extended with a second programmatic code block showing `HardwareVerifierBundleConfig` (custom bundle IDs, custom RP ID, custom root PEM overrides, revocation snapshot) — the surface a third-party verifier needs to wire motebit-flavor verification against forked or federated builds.

  **`@motebit/verifier`**: README extended to document `verifySkillDirectory` (path-to-skill-directory → result, for skill bundles shipped as a tree rather than a single file).

  **`@motebit/crypto-appattest` / `-tpm` / `-webauthn` / `-android-keystore`**: each README now carries a "Lower-level primitives" section listing the bare-metal verifier entries (`verifyAppAttestReceipt`, `verifyTpmQuote`, `verifyWebAuthnAttestation`, `verifyAndroidKeystoreAttestation`), parsers, format-string constants, security-level / verified-boot-state literals, and the pinned vendor-root PEM identifiers exported for `HardwareVerifierBundleConfig` override. Same shape across all four leaves — sibling consistency holds.

  Doctrine surfaces synced in the same pass: `apps/docs/content/docs/concepts/public-surface.mdx` now lists `@motebit/state-export-client` in the Apache-2.0 publish set (was previously omitted from the bulleted list despite the count saying 11); `apps/docs/content/docs/operator/architecture.mdx` extends the package's one-liner to mention the v1.1 inner-receipt verifier.

  Structural lock added: `check-readme-public-exports` (drift-defense #91) — every named value export from a publish-surface package's `src/index.ts` MUST appear as a word in that package's `README.md`. `WAIVED_EXPORTS` registers acknowledged debt (currently 148 entries across `@motebit/protocol` and `@motebit/crypto` — categorical, traceable, ratchet-downward). Adversarial probe in `check-gates-effective` (probe #84). Without this gate, the next minor bump that adds a public export without README mention silently reproduces the 2026-05-11 shape; with it, CI catches the drift in the same commit.

- 605d288: Initial release of `@motebit/state-export-client` — the browser-safe consumer-side primitive that closes the producer-consumer asymmetry left by the state-export-signing arc. Apache-2.0 (permissive floor), Layer 6.

  Two exports:

  ```ts
  import { fetchTransparencyAnchor, verifiedStateExportFetch } from "@motebit/state-export-client";

  // Trust-on-first-use bootstrap from /.well-known/motebit-transparency.json.
  // Verifies the declaration's self-signature against the embedded
  // relay_public_key and returns the pinned TransparencyAnchor.
  const result = await fetchTransparencyAnchor("https://relay.example.com");
  if (!result.ok) throw new Error(`anchor: ${result.reason}`);

  // Per-call fetch wrapper. Reads X-Motebit-Content-Manifest from the
  // response, verifies against the body bytes, and (when anchor is set)
  // pins the producer key. Returns { body, bodyBytes, verification }.
  const { body, verification } = await verifiedStateExportFetch(
    `${relayUrl}/api/v1/audit/${motebitId}`,
    {
      anchor: result.anchor,
      init: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
  ```

  Sibling of `@motebit/verify` (CLI for files on disk); same crypto primitives, different consumer surface. Apps that need in-browser state-export verification (admin dashboards, operator consoles, panels rendered into web) import this package; auditors who downloaded a state export to a file use the `motebit-verify content-artifact` CLI sibling.

  The doctrine §8 producer-consumer loop is now closed at the product layer: producer #86 (`check-state-export-signed`) + registry #85 (`check-artifact-type-canonical`) + consumer #87 (`check-state-export-consumer-verifies`).

  First consumer: `apps/inspector` (admin dashboard) wires every state-export read through this package as of 2026-05-11. Per-call verification surfaces a failure chip in the inspector header when any panel's manifest fails verification — calm-software register: silent on the verified path, visible only on tamper.

  Failure reasons (typed, for audit logging):
  - `manifest_header_missing` — response had no `X-Motebit-Content-Manifest` header
  - `malformed_manifest_header` — header was not valid base64url-encoded JSON
  - `content_hash_mismatch` — body bytes don't match the manifest's content_hash
  - `signature_invalid` — manifest signature did not verify against the declared key
  - `producer_key_mismatch` — declared key differs from the anchor's pinned key
  - `malformed_public_key` / `malformed_signature` / `unsupported_suite` — manifest internals

  Doctrine: `docs/doctrine/nist-alignment.md` §8, `docs/doctrine/self-attesting-system.md`, `docs/doctrine/operator-transparency.md`.

- 3494459: Close the trust-on-first-use (TOFU) savant gap on `/.well-known/motebit-transparency.json` with the onchain-anchor cross-check primitive. Two new exports:

  ```ts
  import {
    lookupTransparencyAnchor,
    verifyDeclarationOnchainAnchor,
  } from "@motebit/state-export-client";

  // Look up the latest transparency anchor at the relay's pinned Solana
  // address. Returns { ok: true, txHash, anchoredHashHex } or a typed
  // failure reason (rpc_failed | no_anchor_found | anchor_hash_mismatch
  // | malformed_memo). No SDK dep — uses Solana JSON-RPC via fetch so
  // the package stays browser-safe and dep-thin.
  const result = await lookupTransparencyAnchor(
    relayAnchorAddress, // pinned out-of-band, like Apple App Attest root
    declaration.hash, // hash from the fetched transparency.json
    { rpcUrl: "https://api.mainnet-beta.solana.com" },
  );

  if (!result.ok) {
    // First-fetch declaration cannot be cross-checked against chain.
    // Reject — possible MITM via DNS hijack, malicious ISP, or compromised CA.
    throw new Error(`transparency anchor: ${result.reason}`);
  }
  ```

  Why this closes a real gap: before the anchor, the first fetch of `/.well-known/motebit-transparency.json` trusted HTTPS + DNS + CAs end-to-end. A DNS hijack, malicious ISP, or compromised CA could substitute a different declaration with the attacker's public key embedded — the self-signature still verifies, against the attacker's key. With the anchor, the verifier reads the declaration's hash from Solana (a separate channel the network provider cannot tamper with) and compares.

  Trust chain:

  ```
  pinned anchor address  (out-of-band trust root, like Apple App Attest root cert)
    → Solana memo        ("motebit:transparency:v1:{hash}", second channel)
    → declaration hash   (commits the operator to one declaration)
    → relay_public_key   (commits the operator to one identity)
    → every X-Motebit-Content-Manifest verifies against that key forever
  ```

  The producer-side anchor lives in `@motebit/wallet-solana::submitTransparencyAnchor` (already shipped); the relay calls it at startup whenever `SOLANA_RPC_URL` is configured. Drift gate `check-transparency-onchain-anchored` (drift-defense #88) enforces the producer wiring; using this package's `lookupTransparencyAnchor` is the verifier-side counterpart.

  Doctrine: `docs/doctrine/operator-transparency.md` § "Stage 2a — onchain anchor (shipped 2026-05-11)"; `docs/doctrine/nist-alignment.md` §8 "Savant gap closed 2026-05-11".

### Patch Changes

- Updated dependencies [f1ba621]
- Updated dependencies [a5bf96e]
- Updated dependencies [1f5b8aa]
- Updated dependencies [45aff03]
- Updated dependencies [891a11b]
- Updated dependencies [f083b7a]
- Updated dependencies [f4aa40d]
- Updated dependencies [f9fd8f2]
- Updated dependencies [a2daccd]
- Updated dependencies [f174164]
- Updated dependencies [5851a24]
- Updated dependencies [5286de2]
- Updated dependencies [c47251c]
- Updated dependencies [b4c38fb]
- Updated dependencies [ea6dc4d]
- Updated dependencies [88d8550]
- Updated dependencies [4bb65d8]
- Updated dependencies [22b6a39]
- Updated dependencies [b7f79b2]
- Updated dependencies [b42cee1]
- Updated dependencies [9c39980]
- Updated dependencies [3f2e370]
- Updated dependencies [e383c63]
- Updated dependencies [eeebf19]
- Updated dependencies [9def0cd]
- Updated dependencies [91299fd]
- Updated dependencies [7ba2761]
- Updated dependencies [c243dd2]
- Updated dependencies [7b87916]
- Updated dependencies [b0f38a8]
- Updated dependencies [f78a82a]
- Updated dependencies [28added]
- Updated dependencies [0c6196c]
- Updated dependencies [ee5f70f]
- Updated dependencies [ef49992]
  - @motebit/protocol@1.3.0
  - @motebit/crypto@1.3.0
