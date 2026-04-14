# @motebit/mcp-client

MCP stdio/HTTP client for motebit-to-motebit and motebit-to-third-party calls. Layer 2, BSL.

## Rules

1. **Credentials resolve per HTTP request, never at connect time.** `CredentialSource` (interface in `@motebit/sdk`, implementations here) is injected into a custom `fetch` that reads `CredentialRequest` and returns a token string or null. Fail-closed: thrown errors propagate per-request; null skips the auth header.
2. **Motebit-to-motebit auth uses static `requestInit`.** Highest precedence. `createCallerToken` emits a signed bearer token (suite `motebit-jwt-ed25519-v1`); the worker's `mcp-server` verifies. Do not route motebit-to-motebit through `CredentialSource`.
3. **Server identity is verified on connect, not trusted.** `ServerVerifier` (interface in `@motebit/sdk`) runs after tool discovery. Fail-closed: `ok:false` or thrown errors disconnect. Four built-in verifiers: `ManifestPinningVerifier`, `AdvisoryManifestVerifier`, `TlsCertificateVerifier`, `CompositeServerVerifier`.
4. **Certificate pinning is law once pinned.** Unexpected cert change must never silently pass. Rotation is an operational continuity event (operator attests), not an identity reset.
5. **No persistence, no rotation, no caching.** Credential lifecycle belongs in adapter implementations (`OAuthCredentialSource` manages OAuth tokens; `KeyringCredentialSource` reads at call time). This package resolves and calls.
6. **`McpClientAdapter` auto-captures `delegation_receipts` from `motebit_task` responses.** Citation chains are the receipt — services that delegate do not manually parse response envelopes.

Concrete `CredentialSource` implementations: `StaticCredentialSource`, `KeyringCredentialSource`, `VaultCredentialSource`, `OAuthCredentialSource`. First `OAuthTokenProvider`: `GitHubOAuthTokenProvider` (refresh-token rotation).
