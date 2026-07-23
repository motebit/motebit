---
"@motebit/crypto": minor
"motebit": patch
---

Add `mintAudienceToken` — the canonical mint seam for audience-bound auth tokens — and sweep every monorepo mint site through it (drift gate `check-token-mint-canonical`, invariant #147).

`createSignedToken` deliberately fills no defaults, so every call site restated `iat` / `exp` / `jti` / TTL — 23 sites across 17 files as of 2026-07-23, grown from ~9 a month earlier. Each restatement is a place for the freshness window or replay nonce to silently drift: the identity→authz instance of the shadow-the-constant class named in `docs/doctrine/composition-preserves-enforcement.md` (reduce the seams where enforcement can disappear). The helper owns the assembly (`iat` = now, `exp` = `iat + ttlMs` defaulting to `DEFAULT_SIGNED_TOKEN_TTL_MS`, `jti` from the platform CSPRNG with a fail-closed no-CSPRNG error) and returns `{ token, payload }` so sites that surface expiry read `payload.exp` instead of re-deriving it. Injected-clock callers (relay-client's token cache, runtime-host's attach handshake) pass `nowMs` — the adapter-pattern clock idiom, not a freshness bypass.

The sweep covers CLI, web, mobile, desktop, spatial, planner, molecule-runner, mcp-client, relay-client, runtime-host, and the relay's browser-sandbox minter; planner's injected `SovereignDelegationConfig.createSignedToken` field became `mintAudienceToken` (mint-shaped) so the seam covers injected minters too. `createSignedToken` stays public API — adversarial test fixtures need exact payload control — but non-test monorepo source minting through it now fails CI. Inventory: 146 → 147 invariants, 134 → 135 hard CI gates.
