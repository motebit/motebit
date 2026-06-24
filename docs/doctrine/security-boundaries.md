# Security boundaries

## Sybil defense (five layers)

Self-delegation must not farm trust.

1. Skip trust record update when `delegator === worker`.
2. Aggregation ignores self-issued credentials.
3. Minimum issuer trust threshold (0.05) excludes new sybil identities.
4. Credential revocation check excludes compromised issuers.
5. Reject self-issued credentials at the submission endpoint.

Self-delegation executes and settles budget — it just produces no trust signal.

## Memory injection defense (two layers)

**Layer 1 — formation gate.** `ContentSanitizer` scans candidates; injection-flagged memories get confidence capped to 0.3 (fast decay, not rejected outright).

**Layer 2 — context boundary.** Two canonical boundary markers, emitted by different components and treated identically as data:

- `[EXTERNAL_DATA source="..."]...[/EXTERNAL_DATA]` for tool results (emitted by `ContentSanitizer`)
- `[MEMORY_DATA]...[/MEMORY_DATA]` for recalled memories (emitted by `ai-core` context packing)

`stripBoundaryMarkers` escapes both marker types in external content to prevent cross-boundary impersonation. System prompt treats both as data, never directives.

## Receipt economic binding

`relay_task_id` is in every `ExecutionReceipt`, inside the Ed25519 signature. The relay verifies the binding at settlement. Prevents cross-task replay. Required — no legacy fallback.

## Token audience binding

`aud` is required on `SignedTokenPayload` (compile-time) and enforced by `verifySignedToken` (runtime). `expectedAudience` is required on all `verifySignedTokenForDevice` calls. Tokens without `aud` are rejected at both layers. The canonical set is the closed `TokenAudience` literal union in `packages/protocol/src/audience.ts` (15 audiences today), drift-locked by `check-audience-canonical` (drift-defense #83). Prevents cross-endpoint replay; a token signed for one audience is rejected by a verifier expecting another.

## Content-artifact provenance binding

Every relay-assembled state-export wraps the response body in a `ContentArtifactManifest` (C2PA-shape) emitted via the `X-Motebit-Content-Manifest` HTTP header. The manifest is Ed25519-signed by `relayIdentity`; the body's SHA-256 hash is bound inside the signed manifest. Witness-composition: the relay attests **only** to what it assembled at time T (its own database state), never to agent actions inside the bundle — those carry their own motebit signatures and verify independently. A verifier hashes the received bytes verbatim against `manifest.content_hash` and verifies the signature against the relay's public key (trust-anchored from `/.well-known/motebit-transparency.json`). Closed-registry `ContentArtifactType` in `@motebit/protocol/src/artifact-type.ts` (12 types today, one per endpoint), drift-locked by `check-artifact-type-canonical` (#85) and `check-state-export-signed` (#86). Third-party verifier: `motebit-verify content-artifact <body> --manifest <header>`. Doctrine: `docs/doctrine/nist-alignment.md` §8.

## Budget-gated delegation

`estimateCost` → `allocateBudget` → `settleOnReceipt`. `HTTP 402` if insufficient. Per-submitter task queue limit (1000/agent, `HTTP 429`) prevents fair-share starvation. Multi-hop: each hop settled independently from nested `delegation_receipts`.

## Rate limiting

5-tier fixed-window per IP: auth 30/min, read 60/min, write 30/min, public 20/min, expensive 10/min. Per-connection WebSocket: 100 msg/10s. Per-peer federation: 30 req/min. Task queue hard-capped at 100K.

## PBKDF2 iterations

600K for user-provided passphrases (CLI identity, relay key encryption). 100K for operator PIN (rate-limiting is primary defense; PIN entry is frequent).

## Signed succession

Key rotation without a centralized revocation registry. Old keypair signs a tombstone declaring the new keypair; both keys sign the canonical payload. Chains verify end-to-end. Succession records must be within a 15-minute freshness window (±1 min clock skew) at the relay.

## Guardian attestation

Organizational custody via Ed25519 guardian key. Guardian key MUST NOT equal identity key (enforced at generation and registration). Registration with `guardian_public_key` requires `guardian_attestation` — a signature by the guardian's private key over `{action:"guardian_attestation",guardian_public_key,motebit_id}`. Prevents fake organizational claims. Same guardian key = organizational trust baseline (0.35) in semiring routing — identity is necessary, not sufficient.

## Federation circuit breaker

Per-peer forward tracking with automatic suspension at 50% failure rate over ≥6 samples. Heartbeat handles liveness (3 missed → suspend, 5 → remove). Circuit breaker handles forward-path health.

## Onchain revocation registry

Key-level revocation events (`agent_revoked`, `key_rotated`) are anchored to Solana immediately via `SolanaMemoSubmitter.submitRevocation()`. Memo format: `motebit:revocation:v1:{revoked_public_key_hex}:{timestamp}`. No batching — revocations are rare and urgent. Fire-and-forget: chain submission failure does not block the revocation itself. Federation heartbeat is primary propagation; the chain is the permanent fallback. `setRevocationAnchorSubmitter()` in `federation.ts` wires it at relay startup. `verifyRevocationAnchor` in `@motebit/crypto` (Apache-2.0) does offline verification. Credential-level revocations are not individually anchored — credentials already have batch anchoring.

## Credential source boundary

Third-party MCP server auth uses `CredentialSource` adapter (`getCredential(CredentialRequest) → string | null`), not static bearer tokens. Credentials resolve **per HTTP request** via custom `fetch` injection — not at connect time. The JSON-RPC body is parsed to extract `toolName` from `tools/call` requests, enabling per-tool scoped credentials. `CredentialRequest` carries `serverUrl`, `toolName?`, `scope?`, `agentId?`.

Four built-in implementations: `StaticCredentialSource`, `KeyringCredentialSource`, `VaultCredentialSource`, `OAuthCredentialSource`. Fail-closed: thrown errors propagate per-request; null skips the auth header. Motebit-to-motebit auth (`createCallerToken`) uses static `requestInit` — highest precedence, unaffected.

The interface lives in `@motebit/sdk` (Apache-2.0, Layer 0) so consumers across layers bind to the contract without pulling in BSL code. Implementations live in `@motebit/mcp-client` (BSL, Layer 2) and are re-exported. Vault implementations belong in higher-layer adapters. The MCP client does not persist, rotate, or cache credentials.

## Server verification boundary

Third-party MCP servers are verified via `ServerVerifier` adapter (`verify(config, tools) → VerificationResult`), run automatically during `connect()` after tool discovery. Fail-closed: `ok:false` or thrown errors disconnect.

Four built-in verifiers: `ManifestPinningVerifier` (fail-closed, rejects on manifest change), `AdvisoryManifestVerifier` (accepts, revokes trust on change — used by desktop/web/mobile/spatial), `TlsCertificateVerifier` (pins SHA-256 fingerprint, Node-only via `node:tls`), `CompositeServerVerifier` (chains multiple, all must pass, merges `configUpdates`). `tlsCertFingerprint` on `McpServerConfig` stores the pinned value.

Cert lifecycle doctrine:

1. Trust-on-first-use is acceptable only for first contact. Once pinned, the pin is law.
2. Unexpected cert change must never silently pass — fail-closed, always.
3. Continuity of trust after rotation requires explicit operator approval, alternate cryptographic proof, or a defined grace rule — never automatic silent repin.
4. Certificate rotation is an operational continuity event, not an identity reset — the server's accumulated trust survives rotation if the operator attests continuity.
5. Policy must be explicit and auditable per integration — no global "trust all rotations" escape hatch.

Proven end-to-end against GitHub's remote MCP server (`api.githubcopilot.com`). All 5 surface apps use `ServerVerifier` instead of manual `checkManifest()`. The interface lives in `@motebit/sdk` (Apache-2.0, Layer 0); implementations in `@motebit/mcp-client`.

## WebSocket post-connect auth

Sync-engine WebSocket adapter sends auth tokens as a post-connect frame (`{ type: "auth", token }`) instead of URL query params. Relay validates and responds with `{ type: "auth_result", ok }`. Fail-closed: rejection or 5-second timeout disconnects. Legacy `?token=` accepted for backwards compat. Unauthenticated connections skip the frame.

## MCP server credential verification (inbound)

Inbound non-motebit auth uses `InboundCredentialVerifier` adapter (`verify(token) → boolean`), not hardcoded string comparison. The "Inbound" qualifier distinguishes it from `mcp-client`'s outbound `CredentialSource` (per-call supplier) and `ServerVerifier` (server identity check). `StaticTokenVerifier` wraps legacy `authToken`. `credentialVerifier` takes precedence over `authToken`. Fail-closed: false or thrown error = 401. The motebit signed-token path (`verifySignedToken`, `resolveCallerKey`, `onCallerVerified`) is untouched.

## External-audit hardening backlog (2026-06)

An external, repo-access adversarial review stress-tested the trust boundaries. **What held (verified):** the cryptographic core (sign/verify, sovereign binding, succession windowing) and the **money gate** — `verifyGrantForTurn` (`@motebit/runtime`) runs the full chain (revocation → `verifyStandingDelegation` → `verifyTokenAgainstGrant`: signature, expiry, all four party fields, scope ⊆ grant, TTL ≤ grant max; `null` on any failure) and is the **sole** producer of `TurnContext.verifiedGrant`, locked by `check-money-authority` (construction anywhere else is a build failure). R4 money has zero auto-execution callers today, so it always requires human approval — the safe failure mode. The findings below are NOT active holes; they are claim-vs-code reconciliations (done) and hardening that must land **with** the feature that activates it, not after (the deferred-with-trigger discipline). The pattern: the math held; the gaps are one layer up, in app key custody and the relay's live-auth — exactly where systems break.

**Reconciled now (claim-vs-code):**

- **Desktop key custody.** Docs claimed the desktop key "never touches the filesystem / never plaintext / OS keyring." The Tauri `keyring_set` (`apps/desktop/src-tauri/src/main.rs`) writes the Ed25519 device key as an owner-only (`0600`) plaintext fallback file on **every** build, because OS-keyring writes are silently dropped on some build signatures and the drop cannot be detected in-process (an in-process round-trip read returns the cached value). The OS-keyring write is best-effort. Docs corrected to state the real posture (`apps/docs/content/docs/concepts/identity.mdx`, `apps/docs/content/docs/developer/identity-crypto.mdx`, `apps/docs/content/docs/security.mdx`). Mobile (Keychain/Keystore, no fallback) and CLI (PBKDF2+AES-encrypted file) match their claims.
- **"Signing never reaches a browser."** Correct as _integrator_ guidance (a backend's service key stays server-side), but the motebit **web app** is a sovereign-motebit-in-browser: the user's own key is held under a non-extractable WebCrypto wrapping key in IndexedDB and `secureErase`d after use — a consumer-wallet trust model, not a server leaking its key. Docs disambiguated (`apps/docs/content/docs/developer/quickstart.mdx`).

**Hardening backlog (deferred-with-trigger):**

- **Verified-keyring-only desktop writes.** Make signed/release builds use the OS keyring exclusively (no plaintext fallback), with the `0600` fallback gated to unsigned dev builds. **Trigger:** per-platform signed-build test capacity (macOS/Windows/Linux) — the existing fallback exists _because_ keyring reliability burned us, so this must be validated on real signed binaries before shipping, or it bricks identities. Until then the fallback is `0600` owner-only and the claim is honest.
- **Per-device revocation.** `POST /rotate-key` updates `agent_registry` + the succession chain but not the `devices` table that token auth reads (`verifySignedTokenForDevice`), and there is no per-device kill-switch short of a full-identity `/revoke`. Identity-key rotation and per-device keys are distinct axes (rotating the identity _shouldn't_ rotate independent device keypairs) — so this is a **design decision**, not a bug: do we add per-device revocation, and should an identity rotation optionally cascade to device keys? **Trigger:** a device-compromise threat scenario / multi-device-revocation requirement.
- **Relay token replay hardening.** `jti` is required-present but not consumed-once (no replay cache; bounded today by spend caps + the 24h withdrawal hold + a client-chosen idempotency key), and `SignedTokenPayload` has no `iss`/relay-origin field, so a token is operation-bound (`aud`) but not relay-bound — structurally replayable against a federated peer relay. **Trigger:** federation going live for money routes (cross-relay replay is latent until then); add (a) single-use `jti` scoped by `exp`, (b) an `iss`/relay-origin field checked at verification.
- **`VerifiedGrant` freshness + the `isRevoked`-less seam.** `verifyGrantForTurn` always wires the revocation seam, but `verifyStandingDelegation`/`verifyTokenAgainstGrant` accept an _optional_ `isRevoked` and skip the check when omitted (documented), and `VerifiedGrant` carries no as-of/freshness dimension — so a verdict built on a stale revocation set is indistinguishable from a fresh one. **Trigger:** wiring the standing-delegation auto-execution path (a grant store + relay `DelegationRevocation` feed). That wiring MUST land _with_ a freshness/as-of field (stale-fails-closed, mirroring the commitment-bond accept-time re-verification, [`commitment-bond.md`](commitment-bond.md)) and a gate forbidding `isRevoked`-less calls on the money path — never after. Connects to [`verify-family-fail-closed.md`](verify-family-fail-closed.md) (the two named fail-open seams).
- **Obvious secrets in an unmarked live conversation.** The sensitivity egress gate (`assertSensitivityPermitsAiCall`, every AI-call entry, `check-sensitivity-routing`) blocks a cloud call when the **effective session** sensitivity is medical/financial/secret — but session sensitivity is user-set + sensitive-slab-source, and there is **no content auto-classification of the user's own live message** (`packages/ai-core/src/loop.ts` pushes it verbatim). Tool results and memory storage ARE deterministically secret-redacted (`packages/policy/src/redaction.ts`: Luhn cards, SSN, API/AWS keys, JWTs, seed phrases, connection strings), but the user's typed input is not. So a credential typed directly into an _unmarked_ cloud session reaches the model. Medical is inherently not pattern-detectable (no regex for a diagnosis) → stays user-controlled by construction; the public claim was corrected to say so (`apps/docs/content/docs/security.mdx`). **Design decision (not a bug — touching the user's own input has UX tension):** redact the secret-class subset (keys/credentials/seed-phrases, NOT cards/SSN which have legitimate use, NOT medical) from the outbound message to a non-sovereign provider — reusing the existing redactor, fail-closed, because the model almost never needs to _see_ a raw credential (agents use keys via the credential/tool path). Recommended option = redact-secret-class-outbound. **Trigger:** owner sign-off on touching the live input path.
