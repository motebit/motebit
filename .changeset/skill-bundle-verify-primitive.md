---
"@motebit/crypto": minor
"@motebit/verifier": patch
---

Promote `verifySkillBundle` to the canonical pure-function full-verify primitive in `@motebit/crypto`. Browser, Node-library, and CLI callers all converge on the same code path once they have `{ envelope, body: Uint8Array, files?: Record<path, Uint8Array> }`.

**Why this exists.** The `motebit-verify` ship gave Node consumers a universal verifier; the browser side (`motebit.com/skills`'s "verify locally" button) had a hand-rolled copy in `apps/web/src/skill-bundle-verifier.ts` that no external consumer could import. Third-party browsers (agentskills.io, registries, CI pipelines) couldn't run the same check. This ship promotes the primitive to the permissive-floor package so anyone composing `@motebit/crypto` gets the canonical verify with no inline reimplementation.

**Three-axis verify, one primitive:**

```ts
import { verifySkillBundle } from "@motebit/crypto";

const result = await verifySkillBundle({
  envelope: parsedEnvelope,
  body: lfNormalizedSkillMdBytes,
  files: { "scripts/run.sh": fileBytes }, // optional
});

// result.steps.envelope.{valid, reason}
// result.steps.body_hash.{valid, expected, actual} | null
// result.steps.files: per-path {valid, expected, actual, reason}
// result.valid iff every axis passed AND every declared file was provided
```

**Refactors:**

- `@motebit/verifier`'s `verifySkillDirectory` now reads SKILL.md / skill-envelope.json / declared files from disk into the bundle shape and delegates to `verifySkillBundle`. Single source of verification semantics; the directory walker is purely an I/O shim. 15/15 directory tests pass unchanged after the refactor.
- `apps/web` deletes its hand-rolled `skill-bundle-verifier.ts` (164 lines) and the matching test (160 lines). `skills-panel.ts` decodes base64 → bytes → `verifySkillBundle` from `@motebit/encryption` (which re-exports the new primitive). Browser bundle now uses the same primitive as the CLI.

**Permissive-floor allowlist:** `verifySkillBundle` added to `PERMISSIVE_ALLOWED_FUNCTIONS` in `scripts/check-deps.ts` per the same pattern as the existing skill-sign / skill-verify entries. The function is pure (no I/O, no policy decisions, no accumulated state) — a third-party Apache-2.0 audit pipeline composing `@motebit/crypto` gets the canonical full-verify with no license friction.

**Single source of truth.** Same `SkillVerifyResult` shape across the CLI's `motebit-verify` JSON output, `@motebit/verifier`'s library API, the browser's local-verify button, and any third-party consumer. Same step semantics, same failure reasons, same JSON-serializable structure for CI pipelines.

Faithful to `services/relay/CLAUDE.md` rule 6 ("relay is a convenience layer, not a trust root") at the primitive level: any consumer with bundle bytes from any source — relay-served, tarball-extracted, peer-to-peer — verifies the same way. No per-surface forks.

Tests: 8 crypto-layer cases covering happy path + each tamper mode at the bundle-shape boundary, 15 verifier directory cases unchanged, web app loses its hand-rolled tests in favor of the upstream primitive's coverage. All passing. Coverage stays above thresholds (verifier 99.06% lines / 87.09% branches; crypto/web/encryption builds clean).
