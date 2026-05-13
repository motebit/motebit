---
"@motebit/ai-core": patch
---

Sibling of `dishonest-closing-sweep-table-driven.md`. The ai-core half of the same sweep — refactored `inspectDishonesty` to data-driven `DISHONESTY_RULES` table, added `blank_page_detected` + `access_denied_detected` rules, parameterized 28+ tests across the table, exported `__DISHONESTY_RULE_FIELDS` for the drift-gate Half-3 sync invariant. See the published-package sibling for the full architectural narrative.

Split per `check-changeset-discipline`: ai-core is in the changeset ignore list (private package, no npm publish); browser-sandbox is published; mixed changesets violate the gate. Same architectural change, two-file split for the version-bump pipeline.
