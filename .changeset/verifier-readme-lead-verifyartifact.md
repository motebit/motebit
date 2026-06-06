---
"@motebit/verifier": patch
---

README: lead the quickstart with `verifyArtifact` (matching the docs) and surface the binding rung.

The npm README led with `verifyFile` while docs.motebit.com leads with `verifyArtifact`, and the README didn't make clear that the identity rung (`result.sovereign`) lives on this package's `VerifyResultWithBinding` — not on `@motebit/crypto`'s bare `VerifyResult`. A third-party integrator reading the npm page (cold-eval) hit both: entry-point drift between the two canonical sources, and `.sovereign` not type-existing if you import from crypto. The README now leads with `verifyArtifact`, mentions `verifyFile` as the Node convenience, and shows the integrity-vs-rung distinction inline. README-only; no code change.
