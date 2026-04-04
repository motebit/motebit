# Session Goal: Wire Remaining Settlement Rails and Credential Sources

## Context

The previous session built the complete boundary architecture for Motebit's auth and settlement stack. Every seam has an interface, at least one implementation, tests, and documentation. This session wires the remaining implementations behind those seams.

## What exists (do not rebuild)

All interfaces are in place. Read CLAUDE.md for the full boundary documentation.

- `SettlementRail` interface in `@motebit/protocol` — four rail types: fiat, protocol, direct_asset, orchestration
- `StripeSettlementRail` in `services/api/src/settlement-rails/` — first implementation, relay wired, 601 tests passing
- `SettlementRailRegistry` — initialized at relay startup, passed to budget routes
- `CredentialSource` interface in `@motebit/sdk` — per-request resolution via custom fetch
- `StaticCredentialSource`, `KeyringCredentialSource` in `packages/mcp-client`
- `ServerVerifier` interface with `ManifestPinningVerifier`, `AdvisoryManifestVerifier`, `TlsCertificateVerifier`, `CompositeServerVerifier`
- `CredentialVerifier` in `packages/mcp-server` — pluggable inbound auth
- All 5 apps migrated to ServerVerifier. All 4 sync adapters accept CredentialSource.
- WebSocket uses post-connect auth frame. Relay handles both auth frame and legacy query param.

## What to build

### 1. X402SettlementRail (protocol rail)

The relay already has x402 config hooks: `X402_PAY_TO_ADDRESS`, `X402_NETWORK`, `X402_FACILITATOR_URL` in `services/api/src/index.ts`. The x402 middleware exists in `services/api/src/tasks.ts`. This implementation:

- Wraps the existing x402 payment flow behind `SettlementRail`
- `railType: "protocol"`, `name: "x402"`
- `deposit()` — x402 is pay-per-request, not deposit-based. Return a `PaymentProof` with the tx hash from the x402 facilitator response
- `withdraw()` — direct stablecoin transfer to a destination address via x402
- `attachProof()` — store x402 tx hash and CAIP-2 network with settlement
- Register in `SettlementRailRegistry` alongside Stripe
- Tests with mocked x402 facilitator

Reference: x402 docs at https://docs.cdp.coinbase.com/x402/welcome, x402.org

### 2. MPPSettlementRail (protocol rail)

Stripe's Machine Payments Protocol. This is newer — check current SDK availability.

- `railType: "protocol"`, `name: "mpp"`
- Uses Stripe PaymentIntents API with Shared Payment Tokens (SPTs)
- `deposit()` — MPP payment intent creation
- `withdraw()` — payout via Stripe Connect or stablecoin
- Register in registry
- Tests with mocked Stripe SDK

Reference: Stripe MPP docs at docs.stripe.com/payments/machine

### 3. BridgeSettlementRail (orchestration rail)

Bridge (Stripe-owned) handles fiat↔stablecoin orchestration.

- `railType: "orchestration"`, `name: "bridge"`
- `deposit()` — Bridge onramp (fiat → stablecoin)
- `withdraw()` — Bridge offramp (stablecoin → fiat)
- `attachProof()` — Bridge transfer ID
- Register in registry
- Tests with mocked Bridge API

Reference: Bridge API docs at apidocs.bridge.xyz

### 4. VaultCredentialSource

For enterprise deployments where secrets live in HashiCorp Vault, AWS Secrets Manager, or 1Password Connect.

- Implements `CredentialSource` from `@motebit/sdk`
- Build the adapter boundary, not the vault. The vault is glucose.
- Constructor takes a vault client interface (async get(key) → string | null)
- Resolves credentials per-request from the vault
- Lives in `packages/mcp-client` or a platform adapter package
- Tests with in-memory mock vault

### 5. OAuthCredentialSource

For MCP servers that use OAuth token exchange (e.g., future GitHub OAuth flow instead of static PAT).

- Implements `CredentialSource` from `@motebit/sdk`
- Constructor takes token endpoint URL, client credentials, scopes
- `getCredential()` returns a cached access token, refreshes when expired
- This is the one case where credential caching is justified — OAuth tokens have explicit TTLs
- Lives in `packages/mcp-client`
- Tests with mocked token endpoint

## Architectural constraints

- **Metabolic principle.** Don't reimplement x402, MPP, Bridge, or vault APIs. Build the adapter boundary. Absorb the SDK as nutrient.
- **Sibling boundary rule.** When you finish a rail, check if the relay's route handling needs updating for that rail type. Budget routes, task routes, federation settlement routes may all need to know about the new rail.
- **Fail-closed.** Every rail and credential source: errors = denial, not fallback.
- **Layer discipline.** Rail interfaces in `@motebit/protocol`. Implementations in `services/api/src/settlement-rails/`. Credential sources in `packages/mcp-client`. Run `pnpm run check-deps` after every change.
- **No credentials in LLM context.** All credential and payment flows are runtime boundaries. The LLM never sees tokens, keys, or payment details.

## What NOT to build

- Don't build a Privy integration yet. Privy is a wallet/provider layer used by DirectAssetRail implementations. Build it when the first DirectAssetRail needs a wallet.
- Don't build TLS cert rotation mechanism. The doctrine is written. The mechanism crystallizes when a real cert rotates.
- Don't build a stablecoin-specific DirectAssetRail yet. That needs Privy or equivalent wallet infra underneath it. Build the rail when the wallet layer exists.
- Don't refactor the relay's internal ledger. Virtual accounts and micro-unit accounting stay as-is. Rails handle external money movement only.

## Verify

After each implementation:

1. `pnpm --filter <package> typecheck`
2. `pnpm --filter <package> test`
3. `pnpm run check-deps`
4. Existing tests must not regress

After all implementations:

1. `pnpm run typecheck` (full monorepo)
2. `pnpm run test` (full monorepo)
3. Update CLAUDE.md with any new boundary documentation

## Priority order

1. X402SettlementRail — x402 hooks already in the relay, closest to working
2. VaultCredentialSource — enterprise requirement, simple adapter
3. OAuthCredentialSource — GitHub OAuth, Stripe OAuth, any token-exchange flow
4. BridgeSettlementRail — Bridge SDK, fiat↔crypto
5. MPPSettlementRail — newest, SDK may still be stabilizing
