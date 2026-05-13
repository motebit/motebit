---
"@motebit/browser-sandbox": patch
---

Identity-keyed session reuse in `BrowserPool` — same motebit + extant session = same session. The `maxConcurrent` cap now measures concurrent MOTEBITS-per-machine, not concurrent TABS-per-machine.

Before: `/sessions/ensure` was misleadingly named — it always allocated a fresh `BrowserContext` via `randomUUID()`. Page reload, Vite restart, hard refresh, or opening a second tab all multiplied Chromium contexts against the cap (default 4). A solo developer iterating dev workflow could exhaust the pool in minutes; the only reclamation was the 10-minute idle reaper. Witnessed 2026-05-12: HTTP 429 `policy_denied` at the exact moment a relay-signed dispatcher tried to open its own legitimate session.

After: when the caller authenticated with a relay-signed token (`auth.ts` sets `c.var.motebitId` from the verified `mid` claim), `/sessions/ensure` routes through new `BrowserPool.ensureSession()`. That checks a `Map<motebitId, sessionId>` reverse index and returns the existing session if alive; allocates fresh only when there isn't one. Dispatcher sees a stable `session_id` across reloads — no client-side `sessionStorage` workaround needed.

Three correctness gotchas, each addressed:

1. **Concurrent-ensure race.** Two simultaneous calls for the same motebit on a fresh process both miss the cache → without protection both allocate, second `Map.set` clobbers the first → orphan leaked. An `inFlightByMotebit: Map<string, Promise<BrowserSession>>` lock dedupes the in-flight allocation; second caller awaits the first's promise and receives the same session.
2. **Stale entry.** A cached session whose underlying `BrowserContext` crashed (Chromium OOM, page panic) leaves the entry in the map while the context is unusable. `isSessionAlive()` probes `page.isClosed()` (defensive against missing method in fakes); falls through to fresh allocation when dead. Defensive failure mode: probe failures treat session as dead — false-negative leaks a context, false-positive surfaces immediately on next action via the existing `session_closed` recovery path.
3. **Index-storage coherence.** `closeSession` reads `session.motebitId` and removes the reverse-index entry; `reapIdle` calls `closeSession` so the same cleanup runs there. Defensive against multi-session-per-motebit interleavings (the lock prevents but the type system doesn't enforce): only deletes when the index actually points to THIS session id.

Cookies-on-reuse semantics: when an existing session is returned, the request body's `cookies` array is IGNORED. Overwriting the in-flight cookie jar with a stale snapshot from disk would discard freshly-acquired CAPTCHA reputation / login cookies the session has accumulated. Cold start (no existing session) seeds normally.

Legacy bearer (no `motebitId` on `c.var`) keeps the fresh-every-call allocation — admin/test tooling intentionally allocates parallel sessions and shouldn't be silently deduplicated. dualAuth applied to allocation: relay-signed → identity-keyed dedup; legacy bearer → fresh-every-call.

Doctrine: "Persistent sovereign identity — a cryptographic entity across time and devices, not a session token" (`CLAUDE.md`). Identity is the foundational primitive; the session id is an internal handle. Allocation by `randomUUID` first + identity decorative was the inversion this change corrects. Compounds with `always-already-slab.md` — the slab persists across reloads only if the underlying session does too.

Wire shape unchanged: `/sessions/ensure` still returns `{ session_id, display }`, same shape whether the response is a fresh allocation or a reuse. No client-side change required (the `CloudBrowserDispatcher` happily receives the same `session_id` across reloads now).

12 new tests: 9 in `chromium-pool.test.ts` (same-motebit reuse, cross-identity isolation, motebitId on session struct, legacy null, closeSession + reapIdle index cleanup, concurrent-race produces one allocation, liveness fall-through on dead page, legacy/identity coexistence) + 3 in `routes.test.ts` (relay-signed end-to-end idempotency, cross-motebit isolation, legacy bearer unaffected). All 241 tests green.
