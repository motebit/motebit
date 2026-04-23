# @motebit/settlement-rails

The three reference `GuestRail` implementations: `StripeSettlementRail` (fiat, depositable), `X402SettlementRail` (protocol, pay-per-request), `BridgeSettlementRail` (orchestration, fiat↔crypto). Plus `SettlementRailRegistry` — the relay's runtime registry of guest rails.

Layer 1. BSL-1.1. Depends only on `@motebit/sdk` types. External SDK coupling (Stripe, Bridge, x402 facilitator) is hidden behind injected client interfaces — every rail absorbs its upstream through a thin port the tests can replace.

Sibling of `@motebit/wallet-solana` (the sovereign-rail reference). Custody is split at the type level: `SettlementRailRegistry.register()` accepts only `GuestRail`; a `SovereignRail` is a `tsc` error. The negative proof lives in `src/__tests__/custody-boundary.test.ts`.

## Rules

1. **Never reach upstream directly.** Every rail depends on a small client interface (`BridgeClient`, `X402FacilitatorClient`, `Stripe` instance). Tests inject fakes; production wires real SDK instances at the consumer. If you add a method, extend the interface — don't import a provider SDK in the rail body.
2. **Storage is not the rail's problem.** Every rail takes an optional `onProofAttached(settlementId, proof)` callback. The relay owns persistence; the rail records intent and emits the proof shape. No DB imports allowed.
3. **Logger is injectable.** Every rail config accepts `logger?: RailLogger`. Default is a silent no-op. The consumer (services/api) injects a structured logger that carries `service: "relay"`, module name, and correlation id. No module-scoped loggers.
4. **Registry accepts only `GuestRail`.** `SettlementRailRegistry.register(rail: GuestRail)` is the sovereignty doctrine as a type signature. Widening to `SettlementRail` would accept `SovereignRail`, which breaks the custody boundary — the `@ts-expect-error` in `custody-boundary.test.ts` guarantees this fails at compile time.
5. **No runtime `@motebit/sdk` imports.** Every import from `@motebit/sdk` is `import type`. The package participates in the permissive-floor (Apache-2.0) type layer without binding to a BSL runtime surface.

## What NOT to add

- DB persistence. Every rail is stateless beyond its injected client + config.
- Background polling, cron loops, webhook HTTP handlers. Those live in the consumer — a rail is a request/response adapter.
- Service-specific business logic. "Which rail do I use for this settlement?" lives in the consumer, not the rail.
- Cross-rail coordination. A rail knows its own provider only.

## Consumers

- `services/api` — the relay. Registers the three rails at boot, dispatches settlement/withdrawal requests, receives proofs and persists them.
