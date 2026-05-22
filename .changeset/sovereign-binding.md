---
"@motebit/crypto": minor
"@motebit/state-export-client": minor
---

Add the sovereign binding rung. `deriveSovereignMotebitId(genesisKey)` derives a UUIDv8 commitment from `sha256(genesisKey)`, and `verifySovereignBinding(motebitId, genesisKey)` checks it — so a sovereign-minted motebit's `motebit_id` IS the commitment to its genesis key, verifiable offline with no operator. `verifyKeyBindingAtTime` now reports `sovereign: true` on its result, and `verifyReceiptDocument` reaches `binding: "sovereign"` (the strongest rung, needing only the identity file — no anchor, no relay, no chain). The genesis key derives from a 32-byte seed, so sovereign ids are recoverable and rotation still works via succession. Additive: sovereign ids are UUIDv8, existing ids are UUIDv7, so they never collide; minting sovereign ids is opt-in.
