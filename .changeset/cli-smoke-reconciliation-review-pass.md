---
"motebit": patch
---

`motebit smoke reconciliation` review pass: extracted `SMOKE_STALE_THRESHOLD_MS` (= 30 min) to a top-level named constant since the same value is referenced by `motebit doctor` and named as a contract in `docs/doctrine/treasury-custody.md` § Phase 1 step 7. Added two tests for non-2xx HTTP responses (401 wrong token, 500 server error) — previously only the network-rejection path was tested. No functional change.
