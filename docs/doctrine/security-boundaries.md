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

`aud` is required on `SignedTokenPayload` (compile-time) and enforced by `verifySignedToken` (runtime). `expectedAudience` is required on all `verifySignedTokenForDevice` calls. Tokens without `aud` are rejected at both layers. Canonical audiences: `sync`, `task:submit`, `admin:query`, `rotate-key`, `pair`, `register-device`. Prevents cross-endpoint replay.

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
