# buffer-polyfill-fixture

Fixtures for `check-browser-surface-buffer-polyfill` (invariant #129), exercised
by `../check-browser-surface-buffer-polyfill.test.ts` via the gate's `--fixture`
mode. Not real workspace packages — inert static files the gate scans.

Four cases pin **both** correctness axes of the gate:

| Fixture       | Shape                                                             | Expected                    |
| ------------- | ----------------------------------------------------------------- | --------------------------- |
| `web-style`   | correct — runtime assignment in `index.html` (web's placement)    | NOT flagged                 |
| `src-style`   | correct — runtime assignment in `src/` module (desktop/spatial's) | NOT flagged                 |
| `missing-all` | wallet-solana dep but no buffer dep, no vite block, no assignment | flagged (all 3)             |
| `no-solana`   | a Vite surface that does NOT reach wallet-solana                  | NOT flagged (not a trigger) |

`web-style` is the regression guard for the original bug: the first cut of the
gate scanned only `src/` and false-flagged the real `apps/web`, whose assignment
lives in `index.html`. A gate that fails on correct code is itself a bug; this
fixture makes "accepts the index.html placement" an executable assertion.
