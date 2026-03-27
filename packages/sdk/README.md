# @motebit/sdk

Product types for building on the Motebit runtime — state vectors, creature behavior, rendering spec, memory graph, AI provider interface.

Re-exports all types from [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) for convenience. If you only need protocol types (identity, receipts, credentials, settlement), use `@motebit/protocol` directly (MIT licensed).

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
- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — signature verification (MIT, zero deps)
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity

## License

MIT
