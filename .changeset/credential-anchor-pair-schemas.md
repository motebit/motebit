---
"@motebit/wire-schemas": minor
---

Publish the credential-anchor pair — two tightly-coupled schemas
opening chain-anchored credential transparency to external verifiers:

- `credential-anchor-batch-v1.json` — relay's signed Merkle root
  over a batch of issued credentials, with optional onchain anchor
  reference (chain + CAIP-2 network + tx_hash + anchored_at).
- `credential-anchor-proof-v1.json` — self-verifiable Merkle inclusion
  proof for one credential within an anchored batch. Carries
  everything needed to verify without trusting the relay: batch
  signature + relay public key, the Merkle path (siblings + layer
  sizes + leaf index), and the optional chain reference.

Why this matters: chain anchoring is the primary mechanism by which
motebit's accumulated reputation becomes externally verifiable
without trusting any relay. A third-party auditor with a credential,
its CredentialAnchorProof, and chain access can prove:

1. The credential was issued at the claimed time
2. It was part of a batch the relay signed
3. That batch's Merkle root was committed onchain (when anchored)

…without contacting the relay for any step. With these schemas,
that verification is mechanical for any language with JSON Schema
validation + Ed25519 + SHA-256.

Different cryptosuite from the find-hire-pay artifacts:
**`motebit-jcs-ed25519-hex-v1`** (HEX signature encoding, not
base64url). That's deliberate — anchor proofs interact with chain
submissions where hex is the convention. Suite registry tracks the
encoding-per-artifact mapping.

Drift defense #23 waiver count: 4 → 2. **22 schemas shipped.**

Remaining 2 waivers:

- BalanceWaiver (settlement-v1 loose end — single TODO)
- CapabilityPrice (permanent structural waiver — covered by nesting
  in AgentServiceListing)
