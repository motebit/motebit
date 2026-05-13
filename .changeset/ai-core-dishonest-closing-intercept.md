---
"@motebit/ai-core": patch
---

Runtime intercept for dishonest closing text — graduates four typed-truth fields from prompt-only teaching to runtime-enforced correction. Sync-invariant graduation: each of the four fields was 2-of-3 of the canonical typed-truth-perception triple (wire + prompt, no runtime); after this commit each is 3-of-3 (wire + prompt + runtime). Doctrine: `runtime-invariants-over-prompt-rules.md` — `synthesizeClosingFallback` was named the exemplar of "make illegal states unrepresentable at the runtime, the prompt teaches what's true about the world, not what to do or not do." This is the exemplar extended to its full scope.

The bug class. Today's prompt teaches the model to read four typed-truth fields and avoid claiming success when they contradict the wire-level fact:

- `navigation_triggered: false` — submit-class action (click / double_click / click_element / key) landed but the page didn't move (cookie banner intercepted, bot-detection silently dropped, form submission blocked)
- `recovery_hint: present` — type-class action ran but `text_appeared: false` (focus race, the field wasn't actually focused)
- `bot_detection_detected: true` — view-class action (screenshot / screenshot_region / read_page) surfaced a CAPTCHA wall, not the intended page content
- `frame_stale` (error reason) — the page navigated underneath the action; even the one-shot retry caught a stale frame

Prompt compliance is probabilistic — the model sometimes drafts "Done." anyway. Witnessed 2026-05-12: user said "press enter" on the cloud-browser slab, the executor returned `navigation_triggered: false`, the model wrote "I pressed enter" — user saw the lie. The runtime had the structural fact and did nothing with it.

The intercept. After the loop terminates with non-empty `finalText`, classify the closing text into one of four registers (`submit` / `type` / `view` / `action`). Walk back through a per-turn `toolResultsLog` to find the most recent terminal action of the relevant kind. Inspect that entry for typed-truth dishonesty. If found, append a correction text chunk in the same turn. Streaming yields text live, so we cannot UNSEND the model's claim; we can only APPEND a correction the user sees before they act on the lie.

Two registers, only one in scope. Five typed-truth fields ride the wire today; the four above are dishonesty-class (each says "the model is about to claim success the wire contradicts"). The fifth — `submit_button_id` — is affordance-class (a hint pointing at what to click next). Affordance-class doesn't belong in this intercept; conflating them would trigger spurious overrides on every successful key Enter where the page also revealed a submit button. Test pin (3) below encodes the register distinction.

LAST-RELEVANT walk-back is load-bearing. A naive intercept that scans the whole tool log and overrides on the first failure introduces a worse bug: the model fails on attempt one, succeeds on attempt two, drafts an honest "Done", and the runtime contradicts a model that correctly recovered. The walk-back finds the most recent terminal action of the relevant kind; if a successful action of the same kind followed a failure, the inspection naturally returns null because the most recent entry IS the successful retry. Test pin (2) below — the regression guard — exercises four retry-and-recover scenarios, one per dishonesty-class field.

Why append-correction over override. The streaming text path yields chunks live (loop.ts ~line 845); by the time we exit the loop, the user has already seen the model's text. Append-correction is the architecturally honest shape — the user sees BOTH what the model said and the runtime's correction, which makes WHO is being unreliable visible to the user (good for trust calibration) rather than papering over the model's lie behind seamless override (which would erode trust if the override was ever wrong).

Three test pins per the reviewer's recommendation:

1. Each of the four dishonesty-class fields triggers override on first-attempt failure — the structural floor (5 cases: navigation_triggered on click, navigation_triggered on key, recovery_hint on type, bot_detection_detected on screenshot, frame_stale error)
2. Successful retry after first-attempt failure does NOT trigger override — the regression guard (4 cases, one per field)
3. `submit_button_id` does NOT trigger override — the register-distinction sanity check (2 cases)

Plus 16 boundary tests on `classifyClosingClaim` (submit / type / view / action patterns, non-claims, mid-sentence references) + edge-case tests on the walk-back (empty log, no relevant action, non-browser tools, buried submit when newer non-submit actions exist). 28 new tests, all green; full ai-core suite at 448/448; graph-wide typecheck clean; 83/83 drift gates green.

Probability framing for future contributors. Prompt-compliance is probabilistic, somewhere around 95-98% per field depending on conversational pressure. For one field, that's tolerable. For four dishonesty-class fields stacked, joint failure probability under independence assumptions is meaningful — every typed-truth field added without a runtime floor is a multiplicative hit to the overall trust contract. The runtime intercept collapses that to 0% on the surface the user sees, regardless of what the model whispers internally. Future typed-truth fields should ship with a runtime check by default (the doctrine's "wire + prompt + runtime" triple) rather than retrofitting a fourth runtime check after another six months of prompt-only drift.

New file: `packages/ai-core/src/dishonest-closing.ts` (helpers + the `detectDishonestClosing` top-level intercept). Loop integration: a per-turn `toolResultsLog` accumulator (~6 lines), three pushes at the success/failure tool-result paths in loop.ts, and a small append-correction block after the existing empty-text fallback. No API breaks; no consumer-facing change beyond the corrected closing text.
