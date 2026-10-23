---
"motebit": patch
---

Stop pointing at what the reference relay has switched off. The README's `withdraw` example names a Solana destination (an EVM `0x` destination is refused before any debit), and a rotation stopped on a write-ahead that will not open, or cannot be used, no longer tells you to "recover through the identity's guardian": guardian recovery is currently suspended on the reference relay, so the message names restoring the passphrase, or keeping the write-ahead file in place.
