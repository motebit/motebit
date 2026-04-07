/**
 * @fileoverview Credential-shaped type family (documentation module).
 *
 * The monorepo has four "Credential/Verifier"-shaped types that are easy to
 * confuse at a glance but are deliberately distinct. They are complementary,
 * not duplicates. Each addresses a different side of the trust boundary.
 *
 * Naming convention:
 *   - `Source`   → supplies a credential (outbound)
 *   - `Verifier` → checks something (identity of a remote, or validity of a token)
 *   - `Adapter`  → persistent storage
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 1. CredentialSource  (OUTBOUND — supply)
 *    Location: `@motebit/mcp-client`
 *    Shape:    `getCredential(CredentialRequest) → string | null`
 *    Role:     Per-call credential supplier used when WE call a third-party
 *              MCP server. Resolved per HTTP request via custom `fetch`
 *              injection so per-tool, per-scope credentials are possible.
 *    Known implementations:
 *      - StaticCredentialSource   (wraps a static bearer token)
 *      - KeyringCredentialSource  (reads from OS keyring per call)
 *      - VaultCredentialSource    (reads from an external vault per call)
 *      - OAuthCredentialSource    (OAuth 2.0 lifecycle with refresh-ahead)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 2. ServerVerifier  (OUTBOUND — check remote identity)
 *    Location: `@motebit/mcp-client`
 *    Shape:    `verify(config, tools) → VerificationResult`
 *    Role:     Verifies the identity / integrity of a third-party MCP server
 *              we are connecting TO. Runs automatically during `connect()`
 *              after tool discovery. Fail-closed.
 *    Known implementations:
 *      - ManifestPinningVerifier   (fail-closed on manifest change)
 *      - AdvisoryManifestVerifier  (accepts, revokes trust on change)
 *      - TlsCertificateVerifier    (pins TLS cert SHA-256 fingerprint)
 *      - CompositeServerVerifier   (chains multiple verifiers)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 3. InboundCredentialVerifier  (INBOUND — check presented token)
 *    Location: `@motebit/mcp-server`
 *    Shape:    `verify(token: string) → Promise<boolean>`
 *    Role:     Checks inbound non-motebit bearer tokens when WE ARE the MCP
 *              server and a third party is calling us. Motebit-to-motebit
 *              signed-token auth is a separate, untouched path.
 *    Known implementations:
 *      - StaticTokenVerifier  (constant-string comparison)
 *
 *    (Previously named `CredentialVerifier` — renamed to make the direction
 *    explicit and avoid collision with the two outbound types above.)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 4. CredentialStoreAdapter  (STORAGE — persist)
 *    Location: `@motebit/protocol`
 *    Role:     Persistent credential storage. The "where credentials live
 *              at rest" boundary — separate from how they are supplied on
 *              the wire (CredentialSource) or how tokens are checked at
 *              either end (ServerVerifier / InboundCredentialVerifier).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Quick mental model:
 *
 *                 WE CALL OUT                WE ARE CALLED
 *                 ───────────                ─────────────
 *   Supply        CredentialSource           —
 *   Check peer    ServerVerifier             InboundCredentialVerifier
 *   Store         CredentialStoreAdapter     CredentialStoreAdapter
 *
 * If you find yourself reaching for "CredentialVerifier" without a direction
 * qualifier, stop and pick the specific type above.
 */
export {};
