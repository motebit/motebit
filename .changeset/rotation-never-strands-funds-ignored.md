---
"@motebit/surface-kit": patch
"@motebit/encryption": patch
"@motebit/sync-engine": patch
"@motebit/relay": patch
"@motebit/desktop": patch
"@motebit/web": patch
"@motebit/mobile": patch
---

Rotation refuses while the old address holds value or the relay holds an open obligation to it, unless explicitly acknowledged; a derived settlement address moves with the key. `@motebit/encryption` adds a fail-closed Solana holdings reader (`createSolanaHoldingsReader`) and the shared on-chain preflight (`checkRotationFunds`, `rotationFundsRefusal`); `@motebit/sync-engine` adds `readRotationObligations` (the authenticated `rotation-obligations` read, signed by the retiring key). `@motebit/surface-kit`'s `performKeyRotation` takes the reader as a REQUIRED port (`readWalletHoldings`) and refuses — before any mint, write-ahead, submission or commit — while the retired key's address holds SOL or any SPL token, while the relay reports a pending / processing withdrawal to it or an admitted, unverified P2P task paying it (`rotationObligationsRefusal` names each and its remedy), or while either read fails, unless the surface passes `acknowledgeFundsAtRisk` (desktop, web and mobile confirm with the refusal stated). The relay serves `GET /api/v1/agents/:id/rotation-obligations` and its `applySuccession` returns and logs the same list (`open_obligations`) without rewriting any of those destinations; it moves only a settlement address (and listing `pay_to_address`) derived from the retired key, in the same transaction as the key, leaving a custom payout address alone. Deferred: the read-to-erase window, token-account rent and stake / nonce authorities, an automatic sweep of the old address.
