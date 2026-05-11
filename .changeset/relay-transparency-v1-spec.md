---
"@motebit/protocol": minor
---

Codify the trust-anchor primitive — `spec/relay-transparency-v1.md` (Stage 2b-i) ships. New exports from `@motebit/protocol`:

```ts
import {
  type SignedTransparencyDeclaration,
  type TransparencySignedPayload,
  type TransparencyAnchorRecord,
  TRANSPARENCY_SUITE,
  TRANSPARENCY_ANCHOR_MEMO_PREFIX,
  TRANSPARENCY_SPEC_ID,
  isSignedTransparencyDeclaration,
} from "@motebit/protocol";
```

`SignedTransparencyDeclaration` is the binding wire shape of the operator-transparency declaration at `/.well-known/motebit-transparency.json`. The declaration is the trust anchor every motebit verifier pins: `relay_public_key` commits the operator to one Ed25519 identity, and every content-artifact manifest, settlement receipt, and federation handshake verifies against that key. The `content` field is operator-extensible per `spec/relay-transparency-v1.md` §3.1 — the protocol commits to the envelope, not to the posture vocabulary inside.

Companion zod schema in `@motebit/wire-schemas::SignedTransparencyDeclarationSchema`; JSON Schema (Apache-2.0) committed to `spec/schemas/signed-transparency-declaration-v1.json`.

**Why now, not deferred per the doctrine's original trigger:** the original `docs/doctrine/operator-transparency.md` Stage 2 deferral bundled "wire-format spec" and "operator-comparison vocabulary" under one "second operator forces field standardization" trigger. The savant-gap critique surfaced the first split (2a onchain-anchor lifted from 2b wire-format); examining 2b under the same lens surfaced a second split: trust-anchor codification (single-operator independent) and operator-comparison fields (multi-operator). After the previous commits made `transparency.json` load-bearing as the trust anchor for state-export verification, the asymmetry between transparency (no spec) and every other trust anchor in motebit (`identity`, `execution-ledger`, `credential`, `credential-anchor`, `settlement` — all with specs) was the gap to close. Stage 2b-ii (operator-comparison fields) stays deferred behind the original trigger.

The reference relay (`services/relay/src/transparency.ts`) now consumes the canonical types from `@motebit/protocol` instead of declaring them inline; `services/relay/src/transparency.ts::SignedDeclaration` is a narrowing of the protocol type that pins `content` to the relay's specific `DECLARATION_CONTENT` shape (operator-extensibility preserved at the protocol layer, narrowed at the consumer).

Doctrine: `spec/relay-transparency-v1.md`, `docs/doctrine/operator-transparency.md` § Stage 2 (split into 2a + 2b-i shipped, 2b-ii deferred), `docs/doctrine/nist-alignment.md` §8.
