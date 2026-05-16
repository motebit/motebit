# @motebit/browser-sandbox

## 0.0.0

### Minor Changes

- c4ce3c5: v1.3 hardening — `navigate` action captures a screenshot inline and
  returns it in the result, so the slab shows the page right after
  navigation regardless of whether the live-screencast endpoint is
  deployed.

  Two earlier shipments composed into a regression: `navigate(url)` was
  added with metadata-only return shape (`ok`, `visual_content_detected`,
  etc., no bytes), and `bytes_omitted` was added so the AI stops
  hallucinating screenshot content. The AI started skipping the
  follow-up `screenshot` action — cheap to call, but the bytes wouldn't
  be in its context anyway. The user's slab dutifully rendered the raw
  JSON metadata because no inline frame was available.

  `doNavigate` now captures `page.screenshot({ type: "jpeg", quality:
60 })` after the page-readiness heuristic and packs `bytes_base64 +
image_format + width + height + captured_at` into the result. JPEG
  60% mirrors the screencast's quality register; PNG would be overkill
  for a navigate snapshot. Capture failure is non-fatal — the metadata
  fields still let the AI describe what happened, and the slab falls
  through to the friendly fallback.

  Privacy contract intact. The `bytes_omitted` projection in
  `@motebit/ai-core`'s `projectForAi` was extended to catch
  `kind: "navigate"` (companion changeset) so the AI never sees the
  inline bytes — same self-instructive marker, same "user has the
  image, you don't" directive.

  Plus: `goto` timeout 30s → 15s, `networkidle` 5s → 2s. Cold-start
  Chromium + 30s/5s ceiling stacked into ~30s wall-clock for fast
  sites; the new ceiling is honest enough for any real first-paint and
  fails fast when the page won't render.

- 91299fd: v1.3 of the virtual_browser arc — `ScreencastFrame` wire-format type
  for live JPEG streaming from the cloud-browser service.

  Per-action screenshots produced "moments" — the slab read as a
  slideshow of stills, not a window into a browser. v1.3 swaps that for
  a continuous JPEG frame stream from CDP `Page.startScreencast`.
  `ScreencastFrame` is the wire shape both the server (`services/
browser-sandbox`) and the dispatcher (`@motebit/runtime`'s
  `CloudBrowserDispatcher`) consume:

  ```ts
  interface ScreencastFrame {
    readonly jpeg_base64: string;
    readonly timestamp: number; // wall-clock ms, normalized from CDP seconds
    readonly device_width: number;
    readonly device_height: number;
  }
  ```

  Lives at the protocol layer next to the `ComputerSession*` cluster —
  both producer and consumer reference one canonical shape, no drift
  between server JSON and client decode.

  Slice 1 of v1.3 (data path). The cloud-browser service ships the
  `GET /sessions/:id/screencast` NDJSON-streaming endpoint; the
  dispatcher ships `openScreencast({onFrame, onError})`; the slab UI
  swap follows in slice 2.

### Patch Changes

- 1abe722: Sweep the dishonest-closing runtime intercept to its dishonesty-class siblings (`blank_page_detected`, `access_denied_detected`) AND lift the inspection logic from per-field branches to a data-driven `DISHONESTY_RULES` table. Adds the meta-sync-invariant that prevents the next sibling sweep from being forgotten.

  **Sibling-boundary rule, applied to itself.** CLAUDE.md: "When you fix one boundary, audit all siblings in the same pass." The 2026-05-12 dishonest-closing intercept fixed four typed-truth fields (navigation_triggered, recovery_hint, bot_detection_detected, frame_stale) but left two persistent-state siblings of bot_detection_detected at 2-of-3 — `blank_page_detected` and `access_denied_detected` ride the same view-class register on the same navigate result, intercepted by the same shape, but were quietly skipped. Not sweeping IS the drift the prior changeset named as the problem ("retrofitting a fourth runtime check after another six months of prompt-only drift"). This commit closes the sweep while the pattern is hot.

  **Refactor to table-driven, in the same commit.** Five rules of identical shape (claim guard → kind guard → field extraction → value check → return string) IS the canonical refactor trigger; doubling down on parallel if-blocks at the moment when the table abstraction becomes self-evident would be wrong shape. `DISHONESTY_RULES` is a `readonly DishonestyRule[]` indexed by `{claims, toolKinds, field, check, honest}`. `inspectDishonesty` becomes a deterministic walk over the table. Three structural payoffs:
  1. **The sync-invariant is now mechanical, not eyeball.** `check-typed-truth-perception` extends with a third assertion (Half 3): every `class: "dishonesty-persistent"` registry entry MUST appear in `DISHONESTY_RULES`. The next sibling-sweep "you forgot a sibling" drift fires the gate, not the user's bug report. Effectiveness probe in `check-gates-effective.ts` plants a rule-removal mutation; gate fires.
  2. **Adding the next field is one row of data.** When a future heuristic adds `subscription_wall_detected` or similar, the diff is one `DISHONESTY_RULES` row + one registry entry with `class: "dishonesty-persistent"` + three test pins (triggers / retry / register-distinction). No copy-paste of the inspection scaffold.
  3. **The 28+ tests parameterize against the table.** Each rule × three pins (triggers-on-failure, retry-doesnt-trigger, register-distinction-holds). Coverage grows linearly with data, not quadratically with maintenance.

  **Field-classification taxonomy made explicit.** Every entry in `TYPED_TRUTH_FIELDS` now carries a `class: TypedTruthClass` field — a const-string-union of six classes. Compile-time enforcement on the taxonomy means adding a new field requires picking a class deliberately; adding an affordance hint to the dishonesty rules becomes a type error, not a code review catch. The 12 registered fields:
  - **dishonesty-persistent** (5): `navigation_triggered`, `recovery_hint`, `bot_detection_detected`, `blank_page_detected`, `access_denied_detected` — durable typed-truth states the model claims to have observed; runtime intercepted via `DISHONESTY_RULES`.
  - **dishonesty-transient** (1): `slow_load` — model claiming "loaded" while the page may finish loading between observation and draft. Out of scope for THIS sweep with structural reason: the walk-back's last-relevant-entry assumption assumes persistence, and slow_load violates persistence. Deferred pending transience-aware semantics (time-budget / polling-aware design). Naming the deferral structurally prevents future-Claude from "completing the sweep" with the wrong walk-back assumption baked in.
  - **affordance** (1): `submit_button_id` — hint pointing at what to click next, not a failure signal. Out of scope by design.
  - **positive-signal** (3): `already_there`, `text_appeared`, `visual_content_detected` — wire fields the model SHOULD reference when true. Dishonest negations are captured by sibling fields' coverage (e.g. `visual_content_detected: false` ≡ `(blank || denied || botDetection)` per the producer derivation, all three intercepted).
  - **control-state** (1): `not_in_control` — about authority, not truth.
  - **transparency** (1): `bytes_omitted_reason` — logging signal about runtime behavior.

  **Producer-side derivation pin for `visual_content_detected`.** Extracted `deriveVisualContentDetected({blankish, denied, botDetection})` as a named exported function (was inline arithmetic in `doNavigate`). Three new tests in `services/browser-sandbox/src/__tests__/action-executor.test.ts` pin the truth table — full visibility case, 7-case negative truth-table, and the structural invariant `visual_content_detected: false ⇔ at least one sibling dishonesty-class field is true`. The invariant is the load-bearing reason `visual_content_detected` doesn't need a separate dishonesty rule (its negation co-occurs with rules that ARE intercepted); a future regression that breaks the derivation — e.g. someone adds a fourth heuristic flag without folding it into the derivation — fires the test instead of silently re-opening the dishonesty surface.

  **Sync-invariant graduation, generalized.** The prior changeset named "4 fields graduate from 2-of-3 to 3-of-3." This sweep brings the dishonesty-persistent count to 5 (added blank*page_detected, access_denied_detected). More importantly, it encodes the dishonesty-class registry AS DATA so the future "is every dishonesty-class field 3-of-3?" question is answered by the gate, not by a code review. The pattern is now a \_finished* exemplar — the next typed-truth field that ships dishonesty-persistent gets the runtime floor by gate-enforced default, not by reviewer eyeball.

  Test counts: ai-core 448 → 454 (6 new dishonest-closing tests covering the two new rules × 3 pins each), sandbox 241 → 244 (3 derivation pins). Drift defenses: 83 hard gates green; 87 effectiveness probes green (one new probe for the dishonesty-persistent sync invariant). Graph-wide typecheck clean. No API breaks.

- 8c9c382: navigate-noop-at-dispatch — `doNavigate` short-circuits with
  `already_there: true` when the page is already at the requested
  URL. Belt-and-suspenders structural floor under the prompt rule
  `navigate-noop-when-already-there` (commit 34ef8a2d): the prompt
  teaches the AI to read [Now] and skip; this stops the roundtrip
  at the dispatch layer when the AI ignores the rule. Same
  defense-in-depth shape as the `not_in_control` gate.

  New `urlsAreEquivalent(a, b)` helper in `src/url-equivalence.ts`
  canonicalizes scheme + host (case-insensitive), strips default
  ports (`:443` https, `:80` http), normalizes trailing slashes
  (`/foo` ≡ `/foo/`, root `/` stays `/`), and compares query +
  fragment verbatim. `doNavigate` calls it against
  `session.page.url()` after URL normalization; on match, returns
  the standard navigate envelope with `already_there: true`,
  `slow_load: false`, and no screenshot bytes — the page didn't
  change, the user's slab still shows it.

  Mock-session refactor in `action-executor.test.ts`: default
  `page.url()` now starts at `about:blank` and the default goto
  canonicalizes via `new URL(url).href`, mirroring real Playwright
  semantics. Fixes the previous mock's "same URL pre- and
  post-goto" footgun that would have caught every existing
  navigate test in the no-op short-circuit.

  Test coverage: 16 unit tests on `urlsAreEquivalent` (case +
  trailing slash + default port + scheme/host/path/query/fragment
  mismatch + malformed input + about:blank); 4 integration tests
  on `doNavigate` (no-op happy path, normalization tolerance,
  query mismatch fires real navigate, cold session fires real
  navigate).

  Companion ai-core changeset: `navigate-noop-at-dispatch-ignored`
  (perception doctrine bullet teaching the AI to read
  `already_there: true` on the result envelope).

- 30fc416: navigate-slow-load-not-failure — fix the AI saying "didn't load"
  while the slab clearly showed the page loaded.

  **The bug Daniel surfaced.** On production /computer:

  open google → ✓ loaded
  open yahoo → ✓ loaded
  open nba.com → AI: "NBA.com timed out — too heavy for the
  browser." But seconds later the slab streamed frames
  showing nba.com fully rendered.
  try google.com → AI: "Timed out — Google didn't load."
  Slab clearly showed Google's homepage with search bar
  and buttons.

  The AI was honest about its tool result; the tool result was
  wrong. `services/browser-sandbox`'s navigate handler called
  `page.goto(url, { waitUntil: "domcontentloaded", timeout:
15_000 })` and rethrew on timeout as a `ServiceError`. But
  goto's 15s timeout is the _DOMContentLoaded readiness ceiling_,
  not the navigation's actual outcome — heavy SPAs and slow CDNs
  commonly commit the navigation, paint partial-then-full content,
  and would settle a few seconds later. Throwing told the AI
  "navigate failed" while the screencast kept showing the page.

  **Fix at the source.** `executeAction` for `navigate` now
  catches Playwright's `TimeoutError` specifically (matched on
  `/timeout|TimeoutError/i`), continues into the heuristic +
  inline-screenshot path, and marks `slow_load: true` on the
  result envelope. The 15s ceiling stays — the
  "honest-failure-faster" intent is preserved — but the failure
  shape now matches reality:
  - `slow_load: true` + `visual_content_detected: true` →
    page loaded, took longer than expected.
  - `slow_load: true` + `blank_page_detected: true` →
    navigation committed, page is still empty (the AI
    describes this honestly).
  - Non-timeout errors (`ERR_NAME_NOT_RESOLVED`,
    `ERR_CONNECTION_REFUSED`, etc.) still propagate as real
    failures — the navigation didn't commit, the slab has
    nothing to show.

  3 new tests in `services/browser-sandbox/src/__tests__/action-executor.test.ts`:
  timeout from goto returns ok:true + slow_load:true;
  Playwright TimeoutError class instance same shape;
  successful goto leaves slow_load:false. The companion
  ai-core prompt-doctrine update lives in
  `navigate-slow-load-not-failure-ignored.md`.

- 4d2d0f8: Identity-keyed session reuse in `BrowserPool` — same motebit + extant session = same session. The `maxConcurrent` cap now measures concurrent MOTEBITS-per-machine, not concurrent TABS-per-machine.

  Before: `/sessions/ensure` was misleadingly named — it always allocated a fresh `BrowserContext` via `randomUUID()`. Page reload, Vite restart, hard refresh, or opening a second tab all multiplied Chromium contexts against the cap (default 4). A solo developer iterating dev workflow could exhaust the pool in minutes; the only reclamation was the 10-minute idle reaper. Witnessed 2026-05-12: HTTP 429 `policy_denied` at the exact moment a relay-signed dispatcher tried to open its own legitimate session.

  After: when the caller authenticated with a relay-signed token (`auth.ts` sets `c.var.motebitId` from the verified `mid` claim), `/sessions/ensure` routes through new `BrowserPool.ensureSession()`. That checks a `Map<motebitId, sessionId>` reverse index and returns the existing session if alive; allocates fresh only when there isn't one. Dispatcher sees a stable `session_id` across reloads — no client-side `sessionStorage` workaround needed.

  Three correctness gotchas, each addressed:
  1. **Concurrent-ensure race.** Two simultaneous calls for the same motebit on a fresh process both miss the cache → without protection both allocate, second `Map.set` clobbers the first → orphan leaked. An `inFlightByMotebit: Map<string, Promise<BrowserSession>>` lock dedupes the in-flight allocation; second caller awaits the first's promise and receives the same session.
  2. **Stale entry.** A cached session whose underlying `BrowserContext` crashed (Chromium OOM, page panic) leaves the entry in the map while the context is unusable. `isSessionAlive()` probes `page.isClosed()` (defensive against missing method in fakes); falls through to fresh allocation when dead. Defensive failure mode: probe failures treat session as dead — false-negative leaks a context, false-positive surfaces immediately on next action via the existing `session_closed` recovery path.
  3. **Index-storage coherence.** `closeSession` reads `session.motebitId` and removes the reverse-index entry; `reapIdle` calls `closeSession` so the same cleanup runs there. Defensive against multi-session-per-motebit interleavings (the lock prevents but the type system doesn't enforce): only deletes when the index actually points to THIS session id.

  Cookies-on-reuse semantics: when an existing session is returned, the request body's `cookies` array is IGNORED. Overwriting the in-flight cookie jar with a stale snapshot from disk would discard freshly-acquired CAPTCHA reputation / login cookies the session has accumulated. Cold start (no existing session) seeds normally.

  Legacy bearer (no `motebitId` on `c.var`) keeps the fresh-every-call allocation — admin/test tooling intentionally allocates parallel sessions and shouldn't be silently deduplicated. dualAuth applied to allocation: relay-signed → identity-keyed dedup; legacy bearer → fresh-every-call.

  Doctrine: "Persistent sovereign identity — a cryptographic entity across time and devices, not a session token" (`CLAUDE.md`). Identity is the foundational primitive; the session id is an internal handle. Allocation by `randomUUID` first + identity decorative was the inversion this change corrects. Compounds with `intent-gated-slab.md` — the slab persists across reloads only if the underlying session does too.

  Wire shape unchanged: `/sessions/ensure` still returns `{ session_id, display }`, same shape whether the response is a fresh allocation or a reuse. No client-side change required (the `CloudBrowserDispatcher` happily receives the same `session_id` across reloads now).

  12 new tests: 9 in `chromium-pool.test.ts` (same-motebit reuse, cross-identity isolation, motebitId on session struct, legacy null, closeSession + reapIdle index cleanup, concurrent-race produces one allocation, liveness fall-through on dead page, legacy/identity coexistence) + 3 in `routes.test.ts` (relay-signed end-to-end idempotency, cross-motebit isolation, legacy bearer unaffected). All 241 tests green.

- Updated dependencies [f1ba621]
- Updated dependencies [a5bf96e]
- Updated dependencies [1f5b8aa]
- Updated dependencies [45aff03]
- Updated dependencies [891a11b]
- Updated dependencies [f083b7a]
- Updated dependencies [f4aa40d]
- Updated dependencies [f9fd8f2]
- Updated dependencies [a2daccd]
- Updated dependencies [f174164]
- Updated dependencies [5851a24]
- Updated dependencies [5286de2]
- Updated dependencies [c47251c]
- Updated dependencies [b4c38fb]
- Updated dependencies [ea6dc4d]
- Updated dependencies [88d8550]
- Updated dependencies [4bb65d8]
- Updated dependencies [22b6a39]
- Updated dependencies [b7f79b2]
- Updated dependencies [b42cee1]
- Updated dependencies [9c39980]
- Updated dependencies [3f2e370]
- Updated dependencies [e383c63]
- Updated dependencies [eeebf19]
- Updated dependencies [9def0cd]
- Updated dependencies [91299fd]
- Updated dependencies [7ba2761]
- Updated dependencies [c243dd2]
- Updated dependencies [7b87916]
- Updated dependencies [b0f38a8]
- Updated dependencies [f78a82a]
- Updated dependencies [28added]
- Updated dependencies [0c6196c]
- Updated dependencies [ee5f70f]
- Updated dependencies [ef49992]
  - @motebit/protocol@1.3.0
  - @motebit/crypto@1.3.0
