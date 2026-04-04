# Session Goal: X402SettlementRail + VaultCredentialSource

## Context

The previous session built the complete boundary architecture for Motebit's auth and settlement stack. Every seam has an interface, at least one implementation, tests, and documentation. This session wires the two highest-signal implementations behind those seams.

## What exists (do not rebuild)

All interfaces are in place. Read CLAUDE.md for the full boundary documentation.

- `SettlementRail` interface in `@motebit/protocol` — four rail types: fiat, protocol, direct_asset, orchestration
- `StripeSettlementRail` in `services/api/src/settlement-rails/` — first rail, relay wired, 601 tests passing
- `SettlementRailRegistry` — initialized at relay startup, passed to budget routes
- `CredentialSource` interface in `@motebit/sdk` — per-request resolution via custom fetch
- `StaticCredentialSource`, `KeyringCredentialSource` in `packages/mcp-client`
- `ServerVerifier` with `ManifestPinningVerifier`, `TlsCertificateVerifier`, `CompositeServerVerifier`
- GitHub live integration test proving full boundary stack against api.githubcopilot.com

## What to build this session

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

### 2. VaultCredentialSource

For enterprise deployments where secrets live in HashiCorp Vault, AWS Secrets Manager, or 1Password Connect.

- Implements `CredentialSource` from `@motebit/sdk`
- Build the adapter boundary, not the vault. The vault is glucose.
- Constructor takes a vault client interface: `{ get(key: string): Promise<string | null> }`
- Resolves credentials per-request from the vault
- Lives in `packages/mcp-client` (same layer as KeyringCredentialSource)
- Tests with in-memory mock vault

## Architectural constraints

- **Metabolic principle.** Don't reimplement x402 or vault APIs. Build the adapter boundary. Absorb the SDK as nutrient.
- **Sibling boundary rule.** After wiring X402SettlementRail, check if task routes and federation settlement routes need updating for the new rail type.
- **Fail-closed.** Every rail and credential source: errors = denial, not fallback.
- **Layer discipline.** Rail implementations in `services/api/src/settlement-rails/`. Credential sources in `packages/mcp-client`. Run `pnpm run check-deps` after every change.

## What NOT to build this session

- MPPSettlementRail — Stripe MPP is newer, protocol/network availability constraints need more research first
- BridgeSettlementRail — Bridge is a larger orchestration surface than a single-session adapter
- OAuthCredentialSource — should be driven by a concrete server flow, not built in the abstract
- Privy integration — wallet layer under DirectAssetRail, build when the rail needs a wallet
- TLS cert rotation — doctrine is written, mechanism deferred until real rotation

## Verify

After each implementation:

1. `pnpm --filter <package> typecheck`
2. `pnpm --filter <package> test`
3. `pnpm run check-deps`
4. Existing tests must not regress

After both implementations:

1. `pnpm run typecheck` (full monorepo)
2. `pnpm run test` (full monorepo)
3. Update CLAUDE.md with new boundary docs

## Future sessions (ordered)

After this session, the remaining implementations in priority order:

1. OAuthCredentialSource — driven by a concrete server (GitHub OAuth, Stripe OAuth)
2. MPPSettlementRail — when Stripe MPP SDK stabilizes
3. BridgeSettlementRail — larger integration, own session
4. DirectAssetRail + Privy wallet — when onchain agent wallets are needed
