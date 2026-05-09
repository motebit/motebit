---
"@motebit/browser-sandbox": patch
---

navigate-noop-at-dispatch — `doNavigate` short-circuits with
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
