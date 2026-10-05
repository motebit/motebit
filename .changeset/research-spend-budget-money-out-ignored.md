---
"@motebit/runtime": patch
"@motebit/molecule-runner": patch
"@motebit/research": patch
---

Per-task paid-spend budget bounds money that LEFT the wallet, not just money that bought a receipt.

- `@motebit/runtime`: `executeGrantedDelegation` takes an optional `maxTotalMicro` hard per-call ceiling (integer micro-units over worker net + every fee leg), enforced after pricing and BEFORE the payment is signed or broadcast — reusing the existing `resolveAndSubmitP2pDelegation` pre-broadcast check — and on the dry-run. Over it, or malformed (NaN / negative / fractional): `budget_exceeded`, no money moved. Absent: unchanged. The dry-run result names the `workerMotebitId` it priced and the quote's `routingTranscript`.
- `@motebit/molecule-runner`: the spend handle forwards `maxTotalMicro`.
- `@motebit/research`: a paid-then-failed hop (post-broadcast timeout / agent_failed / unconfirmed) is charged to the budget; every live paid hop carries the remaining budget as its ceiling and is pinned to the quoted worker; a non-finite budget is zero paid hops; invalid budget env refuses the boot; the tool-call cap is checked per tool_use.
