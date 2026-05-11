# @motebit/state-export-client

Browser-safe verifier for motebit state-export responses. Wraps `fetch` with `X-Motebit-Content-Manifest` verification + a trust-on-first-use bootstrap from `/.well-known/motebit-transparency.json`.

Apache-2.0 (permissive floor). Consumes `@motebit/crypto` + `@motebit/protocol` only. Zero new cryptographic logic; zero implicit network calls; fail-closed on every verification path.

## Why

Every state-export endpoint in `services/relay/src/state-export.ts` emits a relay-signed `ContentArtifactManifest` in the `X-Motebit-Content-Manifest` HTTP header. Producer-side signing is invisible truth unless a consumer demands the signature. This package is that consumer — drop it into any browser app and every state-export read becomes self-attesting.

## Quick start

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

## Trust-anchor chain

```
/.well-known/motebit-transparency.json
  → declaration is self-signed; signature verifies against embedded relay_public_key
  → cache the key (TOFU)
  → every X-Motebit-Content-Manifest verifies against the pinned key
```

The operator-transparency declaration is the trust root. See [`docs/doctrine/operator-transparency.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/operator-transparency.md) and [`docs/doctrine/nist-alignment.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/nist-alignment.md) §8.

## Failure reasons

Every verification failure carries a typed reason for audit logging:

- `manifest_header_missing` — response had no `X-Motebit-Content-Manifest` header
- `malformed_manifest_header` — header was not valid base64url-encoded JSON
- `content_hash_mismatch` — body bytes don't match the manifest's content_hash
- `signature_invalid` — manifest signature did not verify against the declared key
- `malformed_public_key` / `malformed_signature` / `unsupported_suite` — manifest internals
- `producer_key_mismatch` — declared key differs from the anchor's pinned key

Non-2xx HTTP responses throw `StateExportFetchError` — the verifier never attempts to verify error envelopes (signing 5xx pages would be misleading provenance for a service outage).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
