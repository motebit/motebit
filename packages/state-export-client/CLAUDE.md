# @motebit/state-export-client

Browser-safe verifier for motebit state-export responses. Apache-2.0 (permissive floor), Layer 6 (Applications). Wraps `fetch` to verify the `X-Motebit-Content-Manifest` HTTP header against the response body bytes; provides the trust-on-first-use (TOFU) bootstrap from `/.well-known/motebit-transparency.json` that produces a pinned `TransparencyAnchor`.

Closes the consumer side of the doctrine §8 self-attesting loop. The producer side ships in `services/relay/src/state-export.ts` (`emitSignedExport` helper, drift-locked by `check-state-export-signed` #86). This package is the symmetric counterpart that turns producer-side signing into an operational invariant: an operator who stops signing breaks every shipping consumer that demands verification, instead of silently degrading without anyone noticing.

## The three-package lineage (verification family)

```
@motebit/crypto                  Apache-2.0  L0  Primitives — verifyContentArtifact, suite-dispatch, canonical-JSON
@motebit/state-export-client     Apache-2.0  L6  This package — browser-safe wrapper around fetch + TOFU bootstrap
@motebit/verify                  Apache-2.0  L6  CLI `motebit-verify` (includes the `content-artifact` subcommand)
```

`@motebit/verify` and `@motebit/state-export-client` are siblings, not stacked: the CLI handles offline file-on-disk verification, this package handles in-browser response-from-fetch verification. Both consume `verifyContentArtifact` from `@motebit/crypto`; neither holds new crypto. The split keeps Node-only CLI helpers (file I/O, argv parsing) out of the browser bundle, and keeps browser-only fetch wrapping out of the CLI's surface.

## Why the trust anchor is necessary

Without an anchor, the verifier accepts any signature against any declared key — a relay that swapped its identity would still pass content-artifact verification because the new manifest declares the new key. The verifier confirms the bytes are signed; it does NOT confirm WHO signed them.

The `TransparencyAnchor` fixes that. It comes from `/.well-known/motebit-transparency.json` (the operator-transparency declaration), which is itself self-signed and self-attesting. The declaration commits the operator to one specific Ed25519 public key. Once a verifier has performed the TOFU bootstrap, every subsequent state-export manifest is checked against the same pinned key — and a key swap raises `producer_key_mismatch` rather than silently accepting the new producer.

The trust-anchor chain:

```
/.well-known/motebit-transparency.json
  → self-signature verifies against embedded relay_public_key
  → cache the key (TOFU)
  → every X-Motebit-Content-Manifest verifies against the cached key
```

The operator-transparency doctrine ([`docs/doctrine/operator-transparency.md`](../../docs/doctrine/operator-transparency.md)) names the declaration as the operator's posture statement; this package makes it load-bearing as the verifier's pinned-key source.

## Rules

1. **No new cryptographic logic lives in this package.** Verification primitives (`verifyContentArtifact`, `verifyBySuite`, canonical-JSON, SHA-256) all come from `@motebit/crypto`. This package wraps + composes them; the audit cost stays low because the crypto surface is upstream.
2. **No implicit network calls.** Every fetch is caller-initiated and inject-able (`fetch: typeof globalThis.fetch` parameter). No module-load-time fetches, no global state, no hidden round-trips. Tests pass mocks; integrators with custom transports (auth proxies, tunneling, service workers) pass wrappers.
3. **Fail-closed, typed reasons.** Every verification failure surfaces a structured reason (`manifest_header_missing`, `content_hash_mismatch`, `signature_invalid`, `producer_key_mismatch`, etc.). Callers branch on `valid` for UI status and `reason` for audit logging. Never silent acceptance, never thrown exceptions for crypto failures — only for HTTP/network errors which the caller's catch should handle.
4. **Browser-safe by construction.** Apache-2.0, zero Node-only imports, ships ESM. The package can be bundled into any web app (apps/inspector, apps/web, panels rendered into web) without polyfill or build complexity.
5. **Anchor optional but recommended.** `verifiedStateExportFetch` accepts an `anchor?` parameter. Without it, the verifier checks the manifest's self-consistency (content_hash + signature against the declared key). With it, the verifier ALSO enforces the producer-key pin. Production callers should always pass an anchor; tests + tooling that don't have one yet still get a partial verification.

## Consumers

Today (target consumers as the wiring lands):

- `apps/inspector/src/api.ts` — admin dashboard fetches 5 state-export endpoints; verifies every response against the relay's pinned key. Verification status flows into the inspector's per-panel UI badge.
- `packages/panels/src/sovereign/controller.ts` — sovereign panel fetches `/api/v1/goals/`; same wrapping.
- Future operator-facing surfaces (apps/web, apps/desktop, apps/mobile when they expose state-export-derived views) — same shape, one helper.

Eventually (potential consumers):

- Third-party auditors who want to verify a downloaded state export in a browser context (the CLI sibling `motebit-verify content-artifact` is the file-on-disk path; this package is the live-fetch path).
- Federation peers that consume state-exports from a peer relay for trust-elevation decisions.

## Drift gate

`check-state-export-consumer-verifies` (drift-defense pending) scans every consumer of `/api/v1/{state,memory,audit,goals,plans,conversations,devices,gradient,sync,execution}/...` and requires the fetch to route through `verifiedStateExportFetch`. Closed-registry / structural-lock shape, same as the sibling gates locking the producer side (`check-state-export-signed` #86 + `check-artifact-type-canonical` #85).

## Doctrine cross-references

- [`docs/doctrine/nist-alignment.md`](../../docs/doctrine/nist-alignment.md) §8 — the third-party-verifier ask + the consumer-side migration that this package operationalizes.
- [`docs/doctrine/self-attesting-system.md`](../../docs/doctrine/self-attesting-system.md) — the doctrine that demands a consumer-side verifier to make producer-side signing non-ceremonial.
- [`docs/doctrine/operator-transparency.md`](../../docs/doctrine/operator-transparency.md) — the trust-anchor source: `/.well-known/motebit-transparency.json` and the declaration's `relay_public_key` field.
