# @motebit/relay-client

The one typed transport for the relay's HTTP surface. Layer 2, BSL.

## Why this package exists

The relay exposes ~180 HTTP endpoints validated server-side against
`@motebit/wire-schemas` — but until this package, the client half of that
contract did not exist. At least six independent `relayFetch`-style helpers
(runtime commands, cli, mobile, sync-engine's HTTP adapter, plus several
runtime singletons) re-implemented URL join + Bearer auth + error handling,
and ~170 hand-written `fetch` call sites typed relay bodies inline. A relay
field rename compiled clean on both sides and failed only at runtime. This
package closes that synchronization gap from the client side.

## The contract-vs-transport split

- **Contract** (zod schemas per endpoint family) lives in
  `@motebit/wire-schemas` (Layer 1) — the canonical zod home, consumable by
  `sync-engine` (Layer 2) directly.
- **Transport** (this package, Layer 2) consumes those schemas and exposes
  typed methods. Consumers: `@motebit/runtime` (L5), apps/cli (L6).
- `@motebit/state-export-client` stays independent — it is Apache-floor
  (this package is BSL) and verifies rather than fetches.

## Contract tiers

Every method states its tier:

- **validated** — response parsed against the committed wire schema;
  mismatch throws `RelayClientError(kind: "schema")`, fail-closed.
- **declared** — no wire schema exists yet for the endpoint; the response
  is typed by a hand-written interface and trusted. Each declared method
  carries a TODO naming the schema-authoring increment. Declared is a
  stepping stone, not a destination.

## Auth

Dual-bearer, resolved per request in strict precedence:
`CredentialSource` (sdk contract) → device-key minting (audience-bound
`createSignedToken`; each method names its `TokenAudience` from the closed
registry in `@motebit/protocol`) → static bearer. Auth-required endpoints
throw `kind: "auth"` before touching the network when nothing resolves.

## One error shape out

Every failure — network, non-2xx, non-JSON body, schema mismatch, missing
credential — is a `RelayClientError` with a closed `kind`. Same discipline
as `@motebit/evm-rpc`.

## Adoption rule

New client code talking to the relay goes through this package. A raw
`fetch` to a relay path outside it is drift; a per-endpoint adoption gate
follows once the runtime + cli sweeps land.
