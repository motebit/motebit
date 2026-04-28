---
"@motebit/relay": patch
---

Strip semver fields from `@deprecated` markers in private (`0.0.0-private`) packages, and add drift gate `check-private-deprecation-shape` (invariant #59) to keep them out.

The 2026-04-23 four-field-classification pass added `@deprecated since X.Y.Z, removed in X.Y.Z` markers across the workspace when most internal packages were still treated as published-shape. The 2026-04-24 sentinel-version flip on 51 internal packages made those semver fields theater: a `removed in 1.1.0` promise on a `0.0.0-private` package has no addressee — there's no v1.0.0 to be `since`, no v1.1.0 to be `removed in`, no consumer across a versioning boundary.

This commit:

- Strips `since X.Y.Z, removed in X.Y.Z. ` prefixes from 15 markers across `@motebit/ai-core` (4), `@motebit/market` (2), `@motebit/runtime` (2), `@motebit/mcp-client` (1), `@motebit/web` (1), and `@motebit/relay` (5 — anchoring + federation legacy aliases). Replacement pointer + `Reason:` block kept on all sites — workspace callers still need them.
- Scopes `check-deprecation-discipline` to `version != 0.0.0-private` packages (the four-field contract still binds published packages).
- Adds sibling gate `check-private-deprecation-shape` enforcing the no-semver shape on private packages (replacement pointer + `Reason:` still required).
- Updates `docs/doctrine/deprecation-lifecycle.md` to spell out the published/private split explicitly.
- Drift-defenses inventory: 58 → 59 invariants (50 hard CI gates).

The new gate caught 6 markers the initial manual audit missed — exactly the case for mechanical defense.
