# @motebit/sdk

Developer contract for building Motebit-powered agents, services, and integrations. The MIT boundary between the open protocol and your application — stable types, adapter interfaces, governance config, plus the product vocabulary the reference runtime consumes (state vectors, creature behavior, rendering spec, memory graph, AI provider interface).

Re-exports all types from [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) for convenience. If you only need the protocol core (identity, receipts, credentials, settlement, trust algebra), use `@motebit/protocol` directly — both are MIT.

## Install

```bash
npm install @motebit/sdk
```

## What's included

Everything from `@motebit/protocol` (re-exported), plus:

- **State vector** — `MotebitState`, `TrustMode`, `BatteryMode`
- **Behavior** — `BehaviorCues`, `SPECIES_CONSTRAINTS`
- **Memory graph** — `MemoryNode`, `MemoryEdge`, `MemoryQuery`, `MemoryStorageAdapter`
- **Rendering** — `RenderSpec`, `GeometrySpec`, `MaterialSpec`, `LightingSpec`
- **AI provider** — `ContextPack`, `AIResponse`, `IntelligenceProvider`, `ConversationMessage`
- **Gradient** — `GradientSnapshot`, `GradientStoreAdapter`, `PrecisionWeights`
- **Export** — `ExportManifest`, `StorageAdapters`

## Related

- [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) — network protocol types (MIT, zero deps)
- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — signature verification (MIT, zero deps)
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity

## License

MIT — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The MIT License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
