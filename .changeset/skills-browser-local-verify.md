---
"@motebit/web": patch
---

Skills v1 — browser-side local re-verify on `motebit.com/skills`.

Closes the relay-as-trust-root violation on motebit's most public surface. The CLI install path (`packages/skills/src/registry.ts`) re-verifies envelope signature + body/file hashes locally before installing; the browser detail view at `motebit.com/skills/<submitter>/<name>@<version>` previously trusted whatever bytes the relay served. A tampering relay could have shown one body, served different bytes, and the browser-side reader would never have known.

`apps/web/src/skill-bundle-verifier.ts` exposes `verifyBundleLocally(bundle)` — a pure async function that:

- Re-runs `verifySkillEnvelopeDetailed` against the embedded public_key (catches signature tampering, suite swaps, public-key swaps)
- Decodes `bundle.body` and recomputes `sha256` to cross-check `envelope.body_hash` (catches body-byte tampering)
- For every entry in `envelope.files`, decodes `bundle.files[path]` and recomputes `sha256` to cross-check `entry.hash` (catches per-file tampering and missing-file cases)

Returns a `VerifyResult` with per-step outcomes so the UI surfaces a checklist (✓ envelope signature, ✓ body hash, ✓ each file path) — failed steps name the canonical reason (`ed25519_mismatch`, `body_hash_mismatch`, `file_hash_mismatch`).

The skill detail view in `apps/web/src/ui/skills-panel.ts` now shows a "verify locally" button next to the install command. Click → spinner → checklist. Verified state renders with a teal-tinted result block; failed state with red-tinted. Hint text under the button explains "re-runs envelope signature + body/file hashes against the bytes the relay just served (no relay trust required)."

Faithful to `services/relay/CLAUDE.md` rule 6 ("relay is a convenience layer, not a trust root"). The web surface now embodies the same independent-verifiability invariant the CLI install path has carried since skills v1 shipped, on the page where most external visitors first encounter motebit's skill ecosystem.

Verified via 6 vitest cases — happy path, body tampering, envelope tampering, file tampering, missing-file detection, and aux-file happy path. Imports route through `@motebit/encryption` (product-vocabulary) per `check-app-primitives` rather than directly from `@motebit/crypto` (Layer-0 permissive floor).
