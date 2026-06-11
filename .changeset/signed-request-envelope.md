---
"@motebit/protocol": minor
"@motebit/crypto": minor
"@motebit/verifier": minor
---

Land `signed-request-envelope@1.0` — stateless per-request identity authentication.

A `SignedRequestEnvelope` authenticates a single request from a registered motebit identity to a service endpoint: the key is the login. It binds the requesting `motebit_id`, a timestamp, a SHA-256 digest of the (detached) request body, and an audience into one Ed25519 signature, verified against the identity's **registered** public key — never a key the request self-asserts. The stateless sibling of `auth-token@1.0`, for a different caller and trust root.

Forced by agency (Q1), who run the inline-payload predecessor in production (`apps/app/lib/signed-request.ts`); their module collapses to a re-export now that the primitives publish.

Adds:

- `@motebit/protocol`: the `SignedRequestEnvelope` type.
- `@motebit/crypto`: `signRequestEnvelope(payload, fields, identityPrivateKey)` + `verifyRequestEnvelope(envelope, registeredPublicKey, options?)` — JCS + Ed25519 + base64url-sig, same suite as the rest of the identity family; the registered key is a verify-side parameter (the trust move). Self-verifiable per crypto rule 4.
- `@motebit/verifier`: re-exports both, so a consumer validates the whole flow through the package it already pins.
- `@motebit/wire-schemas` (private): zod schema + committed `spec/schemas/signed-request-envelope-v1.json` (parity-locked).
- `spec/signed-request-envelope-v1.md` + `scripts/check-signed-artifact-verifiers.ts` REGISTRY entry (`SignedRequestEnvelope` → `verifyRequestEnvelope`).

Three review improvements over agency's draft are folded in: the detached `payload_digest` (envelope detaches from the body), the verifier MUST parse-then-canonicalize the received body (§7.2), and `aud` is a free-form audience string rather than the coarse `TokenAudience` registry.
