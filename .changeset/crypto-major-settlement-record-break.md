---
"@motebit/crypto": major
---

`@motebit/crypto` publicly exposes the settlement-receipt API whose shape is broken by `@motebit/protocol@2.0.0`'s now-required `SettlementRecord.settlement_mode`. The crypto major versions that break honestly.

**Why this is a major bump.** `packages/crypto/src/index.ts` does `export * from "./artifacts.js"`, surfacing three breaking changes in crypto's published API:

1. `signSettlement(settlement: Omit<SettlementRecord, "signature" | "suite">, ...)` now REQUIRES `settlement_mode` in its input — a caller that built the settlement object without it no longer typechecks.
2. `verifySettlement(settlement: SettlementRecord, ...)` takes the reshaped record.
3. The re-exported `SettlementRecord` type itself gained the required `settlement_mode` field — `import { SettlementRecord } from "@motebit/crypto"` consumers that construct one break.

`@motebit/crypto` is the standalone, zero-monorepo-dep verifier, so its published surface is a third-party contract. Shipping a required-field addition to `signSettlement`'s input as a minor would silently break `@motebit/crypto@^1` consumers. It majors in lockstep with the protocol break it re-exposes — the same reasoning as the sibling `@motebit/sdk` major.

## Migration

Supply `settlement_mode: "relay" | "p2p"` when constructing the settlement object passed to `signSettlement`, exactly as for `@motebit/protocol@2.0.0`'s `SettlementRecord` change. Reads of `SettlementRecord` (including via `verifySettlement`) gain the field automatically.
