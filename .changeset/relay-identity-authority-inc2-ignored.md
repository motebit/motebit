---
"@motebit/relay": minor
"@motebit/persistence": patch
---

Identity authority, Inc 2 — SHADOW (docs/design/identity-authority-writers.md §7). Refuses nothing new: every request that succeeds today answers the same.

- `identity-authority.ts`: the single writer of money doors #1 (`/agents/register`), #3 (`sweep-config`), #4–5 (`/listing`), #6 (`/withdraw`). `writeAuthority` takes a `ProvenKey` — a runtime capability minted only by `proveCurrentKey` after an `X-Motebit-Authority` request (`@motebit/crypto` `signAuthorityRequest`) verifies under the identity's CURRENT key for exactly that field, body digest and relay; the signature is consumed once (migration v59 replay store). Without the header the door writes exactly as before (`writeAuthorityUnproven`). A bad header is 401 `authority:<reason>`, recorded.
- `installAuthorityGuards`: TEMP triggers on every census authority column RECORD a write that did not come through the writer — one `relay_auth_events` row (`authority_write_outside_writer`) per request and subject — and never abort. The transparency declaration names the record.
- Ported from #875: `key-proof-replay.ts`, migrations v58 (`relay_registry_key_evidence`), v59 (`relay_key_proofs_accepted`), v60 (`relay_guardian_evidence`), `verifyKeyPossession`, `refuseSovereignIdSquat`, `claimsSovereignId` (library only; Inc 3 wires them).
- `@motebit/persistence`: `DatabaseDriver` gains an optional `function()` hook (better-sqlite3 implements it).
