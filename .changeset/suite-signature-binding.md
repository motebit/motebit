---
"@motebit/crypto": patch
"@motebit/state-export-client": patch
---

Pin the cryptosuite wherever `suite` sits outside the signed bytes (F-20).

`verifyTransparencyDeclaration`, `verifyAgentRevocationRecord` and `verifyAgentRevocationFeed` (`@motebit/state-export-client`) and the multi-signature arms of `verifyDeletionCertificate` (`@motebit/crypto`) dispatched signature verification on a `suite` value the signature does not cover, so an artifact whose `suite` was rewritten to any other registered `SuiteId` without re-signing still verified. Each verifier now pins the suite its artifact is produced under (`TRANSPARENCY_SUITE`, `AGENT_REVOCATION_SUITE`, `DELETION_CERTIFICATE_SUITE`) and rejects anything else (`unsupported_suite` / signature invalid). Every producer already stamps exactly these suites, so every previously valid artifact still verifies; the signed bytes are unchanged.
