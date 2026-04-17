---
"@motebit/wire-schemas": minor
---

Publish `delegation-token-v1.json` — the wire-format contract for signed
delegation authorizations. Every delegated ExecutionReceipt traces back
to one of these tokens; third-party delegates (Python workers, Go
services, Rust verifiers) can now validate the authorization envelope
before accepting work, using only the published schema + any Ed25519
library.

Extracted the shared JSON Schema assembly helper into its own
`assemble.ts` module — two wire formats now use it, and new ones will
follow the same pattern (read TypeScript type → write zod schema with
type parity assertion → register in build-schemas.ts → add drift case
→ ship).

The public-key fields are pattern-constrained to lowercase 64-hex
(enforced by the zod schema AND surfaced as `pattern` in the JSON
Schema, so external validators catch malformed keys too). The scope
field is free-form per market-v1 §12.3 with the wildcard convention
preserved as a minimum-length-1 string.
