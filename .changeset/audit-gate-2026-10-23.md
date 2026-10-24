---
"@motebit/docs": patch
"@motebit/proxy": patch
---

Dependency triage, 2026-10-23: `next` ≥16.4.1 in the docs site and the proxy (two critical, one high), `follow-redirects` ≥1.16.1, `vite` ≥8.2.4 and `body-parser` ≥2.4.0 via upper-bounded overrides, and the zod-3 array-issue advisory (CVE-2023-54404) accepted with a reachability argument and lift trigger in `docs/security/dependency-triage.md`. The production audit gate is green again.
