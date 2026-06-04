# @motebit/state-export-client

Browser-safe verifier for motebit state-export responses. Wraps `fetch` with `X-Motebit-Content-Manifest` verification, performs trust-on-first-use bootstrap from `/.well-known/motebit-transparency.json`, and recursively verifies inner agent signatures on v1.1 execution-ledger bundles.

Apache-2.0 (permissive floor). Consumes `@motebit/crypto` + `@motebit/protocol` only. Zero new cryptographic logic; zero implicit network calls; fail-closed on every verification path.

## Why

Every state-export endpoint in `services/relay/src/state-export.ts` emits a relay-signed `ContentArtifactManifest` in the `X-Motebit-Content-Manifest` HTTP header. Producer-side signing is invisible truth unless a consumer demands the signature. This package is that consumer — drop it into any browser app and every state-export read becomes self-attesting.

A v1.1 execution-ledger goes one layer deeper: the outer manifest is signed by the relay (witness-composition "I assembled these bytes"); the inner `signed_receipts[]` field carries byte-identical canonical JSON of each delegated motebit's own signed `ExecutionReceipt`. `verifyInnerSignedReceipts` recursively audits each one. A relay cannot fabricate inner signatures without holding the delegate motebits' private keys.

## Quick start — verified state-export fetch (outer envelope)

```ts
import { fetchTransparencyAnchor, verifiedStateExportFetch } from "@motebit/state-export-client";

// Once, at app boot — trust-on-first-use bootstrap.
const anchor = await fetchTransparencyAnchor("https://relay.example.com");
if (!anchor.ok) throw new Error(`anchor: ${anchor.reason}`);

// Per state-export call — wrap fetch.
const { body, verification } = await verifiedStateExportFetch(
  "https://relay.example.com/api/v1/audit/MY_MOTEBIT_ID",
  {
    anchor: anchor.anchor,
    init: { headers: { Authorization: `Bearer ${token}` } },
  },
);

if (verification.valid) {
  console.log("✓", verification.artifactType, verification.producerDid);
} else {
  // Banner the panel; log to audit; never silently render unverified state.
  console.error("✗", verification.reason);
}
```

## Quick start — inner-receipt recursive verification (v1.1 execution-ledger)

```ts
import { verifiedStateExportFetch, verifyInnerSignedReceipts } from "@motebit/state-export-client";

const { body, verification } = await verifiedStateExportFetch(
  `https://relay.example.com/api/v1/execution/${motebitId}/${goalId}`,
  { anchor: anchor.anchor, init: { headers: { Authorization: `Bearer ${token}` } } },
);
if (!verification.valid) throw new Error(`outer: ${verification.reason}`);

const inner = await verifyInnerSignedReceipts(body);
if (inner.applicable && !inner.allValid) {
  for (const r of inner.results) {
    if (!r.valid) console.error(`✗ ${r.taskId} (${r.motebitId}): ${r.reason}`);
  }
}
```

`verifyInnerSignedReceipts` returns `applicable: false` for v1.0 bodies, non-execution-ledger bodies, or bodies with an empty `signed_receipts` field — calm-software default, no flag required. On v1.1 bodies, every entry is parsed, every signature is checked against its embedded public key, and `delegation_receipts` chains are walked recursively.

## Quick start — verify a pasted receipt (receipt.computer)

```ts
import { verifyReceiptDocument } from "@motebit/state-export-client";

const v = await verifyReceiptDocument(pastedJsonText);

if (v.binding === "revoked") {
  show(`Key revoked — do not trust (revoked at ${new Date(v.revokedAt!).toISOString()})`);
} else if (!v.integrity) {
  show(`Verification failed: ${v.reason}`); // malformed_json | not_a_receipt | signature_invalid | …
} else if (v.binding === "anchored" || v.binding === "pinned") {
  show(`Verified — from ${v.motebitId}`); // key bound to the motebit (anchored adds on-chain non-equivocation)
} else {
  // integrity-only: signature is valid but checked against the receipt's OWN
  // embedded key — proves the bytes weren't tampered, NOT that the key belongs
  // to motebitId. Never render "from <motebit>" here.
  show("Signature verified — identity not anchored");
}
```

`verifyReceiptDocument` is the brain behind a public, login-free receipt verifier. It runs entirely offline (no relay) for the integrity check, never throws on bad input (typed `reason`s instead), and keeps **integrity** (the bytes were signed, untampered) strictly separate from **binding** (the key belongs to this `motebitId`). The binding ladder: `integrity-only` (no options) < `pinned` (pass `options.identity` — the key is time-valid in the motebit's own succession chain) < `anchored` (also pass `options.anchor` — the binding is in the relay's transparency log AND that root is independently confirmed on-chain). Never render "from &lt;motebit&gt;" below `pinned`. `revoked` is off the ladder — a poison verdict: pass `options.revocation` and if the signing key has an on-chain revocation memo dated at/before the receipt, `binding` is `revoked` regardless of everything else (read from the neutral chain, never the relay's word).

## Quick start — verify the agent-revocation feed (operator moderation history)

```ts
import { fetchTransparencyAnchor, verifyAgentRevocationFeed } from "@motebit/state-export-client";

// Pin the relay key (TOFU), then audit the operator's de-listings offline.
const anchor = await fetchTransparencyAnchor("https://relay.example.com");
const feed = await (await fetch("https://relay.example.com/api/v1/agents/revocations")).json();

const v = await verifyAgentRevocationFeed(
  feed,
  anchor.ok ? anchor.anchor.relayPublicKeyHex : undefined,
);
if (v.ok) show(`Verified ${v.count} signed de-listing/reinstatement record(s)`);
else show(`Feed verification failed: ${v.reason}`); // signature_invalid | producer_key_mismatch | record_invalid | …
```

`verifyAgentRevocationFeed` verifies the feed's signed digest **and** every contained record against the pinned relay key; `verifyAgentRevocationRecord` verifies a single record standalone. This is the consumer side of the operator's de-list power made accountable ([`spec/agent-revocation-v1.md`](../../spec/agent-revocation-v1.md)): a relay can remove an agent from Discover, but only by emitting a signed, reasoned record anyone can fetch and verify — de-list, never de-identify. Same fail-closed, typed-`reason` contract as the verifiers above; same pinned key as `verifyTransparencyDeclaration`.

## Trust-anchor chain

```
/.well-known/motebit-transparency.json
  → declaration is self-signed; signature verifies against embedded relay_public_key
  → cache the key (TOFU)
  → every X-Motebit-Content-Manifest verifies against the pinned key
  → every inner signed_receipts[] entry verifies against its own embedded public_key
```

The operator-transparency declaration is the trust root. The relay's identity key signs the declaration _and_ every state-export manifest, so a single TOFU bootstrap commits the relay to a specific Ed25519 key across every endpoint. Inner receipts carry their own embedded public keys signed by the delegate motebits — the relay cannot rotate those without holding the delegates' private keys.

See [`docs/doctrine/operator-transparency.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/operator-transparency.md), [`docs/doctrine/nist-alignment.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/nist-alignment.md) §8, and [`spec/execution-ledger-v1.md`](https://github.com/motebit/motebit/blob/main/spec/execution-ledger-v1.md) §4.3.

## Onchain anchoring (Stage 2)

The transparency declaration is anchored to Solana via a Memo program transaction. `verifyDeclarationOnchainAnchor` and `lookupTransparencyAnchor` together let a verifier confirm the declaration's hash was posted onchain by the relay's identity key, closing the "operator deletes the JSON file" disappearance gap.

```ts
import {
  lookupTransparencyAnchor,
  verifyDeclarationOnchainAnchor,
} from "@motebit/state-export-client";

const lookup = await lookupTransparencyAnchor({
  declarationHashHex: anchor.anchor.declarationHashHex,
  signerAddress: anchor.anchor.relaySolanaAddress, // optional pin
});
if (lookup.ok) {
  const proof = await verifyDeclarationOnchainAnchor(declaration, lookup.anchor);
  if (!proof.ok) console.error("✗", proof.reason);
}
```

The same on-chain channel raises a receipt's binding to `anchored`. The relay's `/identity/:motebitId` bundle carries a transparency-log inclusion proof and the tx that posted its root; `lookupIdentityLogAnchor` confirms that root really sits on-chain at the relay's **pinned** address (passed out-of-band, never from the bundle). Wire it through `verifyReceiptDocument`:

```ts
import { lookupIdentityLogAnchor, verifyReceiptDocument } from "@motebit/state-export-client";

const v = await verifyReceiptDocument(pastedJsonText, {
  identity, // the motebit's identity file (reaches `pinned`)
  anchor: {
    proof: bundle.anchored.proof, // from GET /api/v1/identity/:motebitId
    relayAnchorAddress: PINNED_RELAY_SOLANA_ADDRESS, // out-of-band trust root
  },
});
// v.binding === "anchored" only when inclusion AND the on-chain root cross-check both pass.
```

## Programmatic surface

| Export                                                     | Kind     | Role                                                                                                                                     |
| ---------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchTransparencyAnchor(baseUrl, opts?)`                  | function | TOFU bootstrap — fetch `/.well-known/motebit-transparency.json`, verify self-signature, return pinned `TransparencyAnchor`               |
| `verifyTransparencyDeclaration(declaration)`               | function | Lower-level: verify a `SignedTransparencyDeclaration` from any source (cached, archived, fixture)                                        |
| `verifiedStateExportFetch(url, opts)`                      | function | Wrap `fetch` — verify outer envelope against body bytes + optional anchor pin                                                            |
| `verifyManifestAgainstBytes(manifest, bodyBytes, anchor?)` | function | Lower-level: verify a parsed `ContentArtifactManifest` against bytes you already have                                                    |
| `verifyInnerSignedReceipts(body)`                          | function | Recursive v1.1 inner-receipt audit — per-receipt verdict with typed failure reasons                                                      |
| `verifyReceiptDocument(jsonText)`                          | function | Verify a pasted/standalone receipt offline — honest view model separating integrity from identity binding (powers receipt.computer)      |
| `lookupTransparencyAnchor(opts)`                           | function | Onchain — query Solana RPC for a Memo program transaction posting the declaration hash                                                   |
| `verifyDeclarationOnchainAnchor(declaration, anchor)`      | function | Onchain — verify the Memo transaction's signer and content match the declaration                                                         |
| `lookupIdentityLogAnchor(address, root, opts?)`            | function | Onchain — confirm a transparency-log root sits on-chain at the pinned relay address (the `anchored` binding rung)                        |
| `lookupKeyRevocation(address, keyHex, opts?)`              | function | Onchain — find a `motebit:revocation:v1:` memo revoking a signing key (the `revoked` poison verdict; read from the chain, not the relay) |
| `StateExportFetchError`                                    | class    | Thrown on non-2xx HTTP; verifier never attempts to verify error envelopes                                                                |
| `MANIFEST_HEADER`                                          | constant | The header name (`"X-Motebit-Content-Manifest"`) — exposed for custom transports                                                         |

All result types (`TransparencyAnchorResult`, `StateExportVerification`, `InnerReceiptsVerification`, etc.) and failure-reason unions are also exported — discriminated unions, type-narrowable by the `ok` / `valid` / `applicable` field.

## Failure reasons

Every verification path surfaces a typed reason for audit logging.

**Outer envelope** (`StateExportVerification.reason`):

- `manifest_header_missing` — response had no `X-Motebit-Content-Manifest` header
- `malformed_manifest_header` — header was not valid base64url-encoded JSON
- `content_hash_mismatch` — body bytes don't match the manifest's content_hash
- `signature_invalid` — manifest signature did not verify against the declared key
- `malformed_public_key` / `malformed_signature` / `unsupported_suite` — manifest internals
- `producer_key_mismatch` — declared key differs from the anchor's pinned key

**Inner receipts** (`InnerReceiptVerification.reason`, per-receipt):

- `malformed_json` — an entry in `signed_receipts[]` was not valid JSON
- `missing_public_key` — the parsed receipt had no `public_key` field to verify against
- `signature_invalid` — the receipt's Ed25519 signature did not verify against its embedded key
- `delegation_failed` — a nested entry in `delegation_receipts[]` failed verification
- `unknown` — wrapped crypto exception (shouldn't normally fire — surfaces opaque failures from the underlying primitive)

Non-2xx HTTP throws `StateExportFetchError` — the verifier never attempts to verify error envelopes (signing 5xx pages would be misleading provenance for a service outage).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
