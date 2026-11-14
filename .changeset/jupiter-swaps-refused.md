---
"motebit": patch
---

`motebit wallet swap` is disabled. The swap signed a transaction built by Jupiter's HTTP API with your identity key without inspecting it, so a compromised or intercepted API response could have moved funds or changed account authority. The command now refuses with "swaps are disabled until intent-bound transaction validation exists" and tells you what to do instead (fund USDC on the Solana network directly and keep at least 0.005 SOL for network fees). It refuses before asking for your passphrase and makes no network call.

The wallet no longer tops up SOL automatically by swapping USDC. A payment or transfer from a wallet holding less than 0.005 SOL is refused before anything is signed, with a message telling you to fund SOL directly. Payments from a wallet with enough SOL work exactly as before. The `motebit wallet` guidance and the grant preflight remedy no longer mention swaps or automatic gas.

The wallet-side change is in `jupiter-swaps-refused-ignored.md`.
