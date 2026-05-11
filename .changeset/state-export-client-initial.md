---
"@motebit/state-export-client": minor
---

Initial release of `@motebit/state-export-client` — the browser-safe consumer-side primitive that closes the producer-consumer asymmetry left by the state-export-signing arc. Apache-2.0 (permissive floor), Layer 6.

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
