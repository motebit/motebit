---
"@motebit/crypto": minor
---

Add `verifyKeyBindingAtTime` — sovereign-root identity binding with time-windowing. Given a motebit's identity file and a signing key, it verifies the succession chain (link signatures + continuity + temporal order) and then checks the key's active window contains a given timestamp, so a since-rotated key does not bind a newer receipt and a future key does not bind an older one. Returns `KeyBindingResult` (`bound`, `genesisPublicKey`, active window, typed reason). Roots in the motebit's own genesis + rotation signatures — no operator trust. A malformed `created_at` fails closed (the genesis key does not bind). The first verifier slice of the anchored binding rung (see `docs/doctrine/identity-binding-verification.md`).
