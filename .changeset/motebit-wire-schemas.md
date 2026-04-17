---
"@motebit/wire-schemas": minor
---

Introduce `@motebit/wire-schemas` — the Layer-1 BSL home for runtime zod
schemas mirroring `@motebit/protocol`'s wire-format types, and the
committed JSON Schema artifacts derived from them.

First wire format published: `ExecutionReceipt` at
`packages/wire-schemas/schema/execution-receipt-v1.json` with stable
`$id`. Third-party Python, Go, or Rust implementers can fetch the
schema via its URL and validate motebit-emitted receipts without
bundling our TypeScript types — the practical foundation for
non-motebit systems to credibly participate in the protocol
(relay-optional settlement, external workers, test harnesses).

Drift defense #22 is a three-way pin: TypeScript (in `@motebit/protocol`)
→ zod schema (here) → committed JSON Schema. Compile-time `satisfies`-
style assertions fail `tsc` if the zod shape diverges from the TS
declaration; a vitest roundtrip fails CI if the committed JSON drifts
from the live zod-to-json-schema output.

Future wire formats (service listings, discovery responses, credentials,
delegation tokens, federation handshakes) will follow the same pattern
— add a module, register in `scripts/build-schemas.ts`, add a drift case.
