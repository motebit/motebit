---
"motebit": patch
---

The turn-closing fallback can no longer deny actions it took (#521). Witnessed on the first local-brain paid hire: a silent model made the runtime say "I didn't take any action there" three times — while its own hire sat pending approval, after the approved $0.25 hire completed, and after the human's refusal. The approval path now threads what it did into the continuation loop, and the floor gained honest variants: pending → "that needs your approval — the request is right above"; refused → "you declined `X` — nothing ran"; completed → "`X` completed — the result is above." Floor invariant: no-action is only claimable when no call was emitted.
