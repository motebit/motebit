---
"@motebit/state-export-client": minor
---

Close the trust-on-first-use (TOFU) savant gap on `/.well-known/motebit-transparency.json` with the onchain-anchor cross-check primitive. Two new exports:

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
