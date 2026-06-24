---
"@motebit/crypto": patch
---

Clarify the `verifyEvidenceProvenance` resolver contract: the injected `resolveProjection` is assumed **total** for any recipe it accepts. A resolver that throws PROPAGATES the exception — a resolver fault is a caller bug, not an evidence verdict, and is never swallowed into a false `present: false` (which would let a broken recipe masquerade as "evidence absent" and hide the bug). To signal "I cannot resolve this recipe," a consumer OMITS the resolver for it and lets the no-resolver path fail closed (`projection_unresolved`) — i.e. inject a resolver only for the recipes you own, and let every other recipe fall through.

Behavior is unchanged — this pins, in the JSDoc contract and an executable test, a property the prose hadn't stated. Surfaced by agency.computer's adoption probe against the published `@motebit/crypto@3.13.0` (the consumer-forces-shape loop): their wrapper already does exactly this. Doctrine: `docs/doctrine/evidence-provenance.md` (Keystone).
