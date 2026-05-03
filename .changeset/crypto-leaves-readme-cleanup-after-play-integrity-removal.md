---
"@motebit/crypto-appattest": patch
"@motebit/crypto-tpm": patch
"@motebit/crypto-webauthn": patch
---

README cleanup — drop the `Related` section bullet pointing at `@motebit/crypto-play-integrity`.

The package was deprecated 2026-04-26, removed from the monorepo 2026-05-03, and the final published artifact (`@motebit/crypto-play-integrity@1.1.3`) carries an npm registry-level deprecation pointing at `@motebit/crypto-android-keystore`. The npm-shipping READMEs of the three sibling crypto-leaves still listed it as a deprecated-but-current sibling, which is no longer accurate — the package is gone from the monorepo and registry-deprecated across all 5 published versions. This patch ships clean READMEs to npm so a reader landing on any sibling's npm page sees the four canonical platform leaves only (`crypto-appattest`, `crypto-android-keystore`, `crypto-tpm`, `crypto-webauthn`) without a stale link to a removed package.

No code changes; no API changes; just README prose. The `crypto-appattest` package's `CLAUDE.md` rule 5 (sibling-list naming) and the `crypto-tpm` package's `CLAUDE.md` rule 3 (cross-platform error-shape note) were also corrected to drop "future Play Integrity" / "deprecated `@motebit/crypto-play-integrity` for one minor cycle" prose; those CLAUDE.md changes are workspace-internal documentation, not part of the npm tarball, so they don't expand this patch's surface beyond the README cleanup itself.
