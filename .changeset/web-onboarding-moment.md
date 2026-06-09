---
"@motebit/web": minor
---

The first-launch onboarding moment — the sovereign funnel's front door (Phase 0, increment 2).

A fresh sovereign mint used to happen silently with no acknowledgement, and the relay never heard about it. The web app now surfaces a calm, one-time moment on first launch: **"Your motebit is born,"** the new identity's word-fingerprint (a recognition aid via `wordFingerprint`), and a choice — **Begin** announces the motebit to the canonical relay's durable intake ledger (so it's counted), **Stay private** keeps it fully local and uncounted.

- New `WebApp.announceMotebit()` — a direct, deterministic relay action (like `startSync`, not routed through the AI loop). Signs with the genesis key (on first launch the device key _is_ the genesis key, so the relay's id↔key binding check passes) and POSTs to `DEFAULT_RELAY_URL`, independent of whether sync is enabled. Best-effort: returns a typed result, never throws.
- `WebApp.isFirstLaunch` is now surfaced from `bootstrapIdentity` (it was previously computed but unused).
- The moment is runtime-driven and shows exactly once per identity: it gates on `isFirstLaunch` + a persisted announce decision (`motebit-announce-intent`). A "Begin" that can't reach the relay (offline) retries silently on a later launch until the relay confirms intake (`motebit-announced`); "Stay private" never announces. The old passive welcome overlay (everyone-sees-it floating tagline) is replaced.

Mint stays sovereign and fully local; announcing is consented intake, never a gate. Verified: web typecheck + build clean, all 15 e2e smoke tests pass, all 111 drift gates pass.
