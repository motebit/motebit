---
"@motebit/web": patch
---

Restore calm software on first launch — replace the onboarding interstitial with a silent announce.

The #165 onboarding moment shipped a Begin / Stay-private decision plus a raw key-fingerprint on the first-launch splash. That violated motebit's own calm-software law ("do not confirm what the user can already see"): it forced the user to make a skeptical decision about a benign, "none"-sensitivity act (announcing a public id + key to the home relay), dramatizing trivial first-party infrastructure as a privacy choice — and gave no feedback when tapped.

This reverts the interstitial and re-homes the intake correctly:

- The first-launch overlay is calm again — "Your motebit is born" + the droplet tagline, a quiet line that fades on its own. No buttons, no decision, no fingerprint on the splash (the word-fingerprint is a recognition aid that belongs in the Agents/identity panel, not cold on hello).
- The announce now fires **silently on the first network action** — `WebApp.startSync()`, where the motebit establishes relay presence, gated on `isAnnounced` so it runs once until the relay confirms and never re-announces. A purely-local motebit that never touches the relay is never announced and stays uncounted — the sovereignty promise kept exactly, and the count becomes "engaged motebits," not page-loaders.
- Removes the dead onboarding-moment code (`runOnboardingMoment`, the announce-intent storage). The `announceMotebit()` primitive and the intake ledger from #163 are unchanged — only _where_ the announce is triggered moved, from a launch-time prompt to a silent network-action hook.

Backend counting is unchanged and still real (top-of-funnel, distinct from Stripe's paid-only view); the mistake was surfacing it as a decision, not building it.
