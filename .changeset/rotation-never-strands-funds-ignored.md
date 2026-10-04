---
"@motebit/surface-kit": patch
"@motebit/encryption": patch
"@motebit/relay": patch
"@motebit/desktop": patch
"@motebit/web": patch
"@motebit/mobile": patch
---

Rotation never strands funds, and no pay-to destination keeps pointing at a retired key. `@motebit/encryption` adds a fail-closed Solana holdings reader (`createSolanaHoldingsReader`) and the shared rotation preflight (`checkRotationFunds`, `rotationFundsRefusal`); `@motebit/surface-kit`'s `performKeyRotation` takes the reader as a REQUIRED port (`readWalletHoldings`) and refuses — before any mint, write-ahead, relay contact or commit — while the retired key's address holds SOL or any SPL token or cannot be read, unless the surface passes `acknowledgeFundsAtRisk` (desktop, web and mobile confirm with the amounts stated). The relay's `applySuccession` moves a settlement address (and listing `pay_to_address`) derived from the retired key to the new key's derived address in the same transaction as the key, leaving a custom payout address alone, so P2P earnings stop landing at a key the worker's surfaces just erased. Deferred: an automatic sweep of the old address.
