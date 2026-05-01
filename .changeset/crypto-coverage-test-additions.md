---
"@motebit/crypto": patch
---

Coverage fix — add 20 tests covering previously-untested branches in `verifyDeletionCertificate`, `verifyRetentionManifest`, the three phase-4b-3 horizon-witness-request-body primitives (`canonicalizeHorizonWitnessRequestBody` / `signHorizonWitnessRequestBody` / `verifyHorizonWitnessRequestSignature`), and `verifyAlternativePeeringArtifact`. Plus `/* c8 ignore */` annotations on two structurally-dead-code defensive catches around `hexToBytes` / `parseInt`-based hex decode (these don't throw on invalid input — `parseInt("zz", 16)` silently returns NaN — so the catches are unreachable today; kept for forward-compat against future hex-decode primitives that might throw).

Coverage now passes all four thresholds: lines 90.22%, statements 90.22%, functions 96.81%, branches 86.23% (vs required 89/89/91/86).

Surfaced when CI failed on commit `8503e23a` with branch coverage 85.06% — the phase-4b-3 arc added enough new lines (`witness-omission-dispute.ts`, `merkle.ts`, three new horizon primitives) that previously-untested code in `verifyRetentionManifest` (untested in crypto's own suite, only via services/relay) tipped the percentage below threshold.

No behavior change. All additions are tests + ignore comments.

Per `feedback_coverage_thresholds` — never lower coverage thresholds, write tests to meet them.
