---
"@motebit/protocol": minor
---

Promote token audiences to a closed registry. Adds `TokenAudience` literal union, named constants for every canonical audience, `ALL_TOKEN_AUDIENCES` (frozen iteration order), and `isTokenAudience` type guard.

The registry covers fifteen audiences across multi-device + identity lifecycle (`sync`, `device:auth`, `pair`, `rotate-key`, `push:register`), task routing (`task:submit`, `admin:query`, `proposal`), virtual accounts (`account:{balance,deposit,withdraw,withdrawals,checkout}`), and the browser-sandbox dispatcher token flow (`browser-sandbox-grant`, `browser-sandbox`).

```ts
import {
  TokenAudience,
  ALL_TOKEN_AUDIENCES,
  isTokenAudience,
  TASK_SUBMIT_AUDIENCE,
  // …
} from "@motebit/protocol";

const aud: TokenAudience = TASK_SUBMIT_AUDIENCE; // typo at literal sites is a compile error
```

Same closure pattern as `SuiteId`, `SettlementRail`, `ToolMode`. The drift gate `check-audience-canonical` (lands alongside this) scans every `aud: "<literal>"` and `createSyncToken("<literal>")` against `ALL_TOKEN_AUDIENCES`; a typo at a signing site that pre-registry would have been a runtime 401 is now caught at compile time + at CI.

`SignedTokenPayload.aud` stays `string` for wire-format compatibility (any `string` still flows through the verifier, which compares against `expectedAudience` literally). The narrowing happens at signing-site callers — they pass `TokenAudience` values; literals outside the registry fail the gate.

Adding an audience is intentional protocol-level work: a new entry in the union, a matching named constant, a registration in `ALL_TOKEN_AUDIENCES`, a doctrine update at `services/relay/CLAUDE.md` Rule 5. Renaming a literal is a wire break; deletions break running deployments.

Existing consumers do not need to migrate; the registry is additive over the existing string literals.
