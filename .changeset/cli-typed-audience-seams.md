---
"motebit": patch
---

Type-safety only, no behavior change: every audience parameter on the CLI's token-minting seams (`getRelayAuthHeaders`, delegate/daemon/self-test mint closures, x402 smoke helper) narrows from `string` to the closed `TokenAudience` registry union re-exported by `@motebit/sdk`. A typo'd or unregistered audience at any CLI signing site is now a compile error instead of a runtime 401. All previously minted values are registry members (including the newly registered `market:query`), so minted tokens are byte-identical.
