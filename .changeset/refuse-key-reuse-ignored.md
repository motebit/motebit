---
"@motebit/relay": patch
---

A key never enters an identity's history twice (#775). `applySuccession`, the one writer behind `/api/v1/agents/:id/rotate-key` (including guardian recovery) and the succession path of `/api/v1/agents/register`, now refuses before writing anything a link whose `new_public_key` (compared lowercase) appears on either side of any recorded link or is the holder or registry key (`reuses_key`), and a link whose `(old, new)` pair is already recorded but is not the head (`replays_recorded_link`). Both doors answer 409 and record the refusal naming the presenter. A retry of the head link stays a no-op 200. This closes the rotate-back (A→B→A) that made every roster consumer refuse the chain as `duplicate_key` forever, and the replay of an earlier guardian recovery that a rotate-back made departable again. `spec/identity-v1.md` §7.5 obligation 3.
