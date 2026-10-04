---
"motebit": patch
"create-motebit": patch
---

Key rotation never strands funds. A motebit's Solana address IS its current Ed25519 identity key, and a rotation retires that key — the CLI erases it once the relay records the rotation — so rotating with SOL, USDC or any SPL token at the old address was a permanent loss with no warning. `motebit rotate` and `npx create-motebit rotate` now read the old address's holdings before anything is minted, written ahead, submitted or erased, and refuse when it holds value (naming the address, what it holds, and the two ways forward: move the funds off it first, or rotate with `--abandon-funds`). A balance read that fails refuses too (fail-closed) unless `--abandon-funds` is given, so an emergency rotation of a compromised key stays possible. Invariant: a key that controls funds or a pay-to destination may not become unrecoverable on the rotation's say-so. Deferred: an automatic sweep of the old address to the new one (out of scope here; the refusal names the manual path).
