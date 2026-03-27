---
"@motebit/protocol": minor
"@motebit/sdk": minor
"@motebit/verify": minor
"create-motebit": minor
"motebit": minor
---

Split @motebit/sdk into @motebit/protocol (MIT) + @motebit/sdk (BSL-1.1).

New package @motebit/protocol contains all network protocol types — identity, receipts, credentials, settlement, trust algebra. MIT licensed, zero dependencies. Third-party relay and verifier implementations should import from @motebit/protocol.

@motebit/sdk re-exports @motebit/protocol and adds product types (state vectors, behavior, rendering, AI provider interface). License changed from MIT to BSL-1.1. All existing imports from @motebit/sdk continue to work unchanged.

If you only need protocol types for interoperability, switch to `@motebit/protocol` (MIT).
