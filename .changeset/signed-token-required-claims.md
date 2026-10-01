---
"@motebit/crypto": patch
---

`verifySignedToken` now rejects, fail-closed, a signature-valid token whose core claims are missing or mistyped (spec/auth-token-v1.md §3: "A verifier MUST reject tokens missing any of them"). Previously a token with no `exp` verified as never-expiring (`undefined <= now` is false), and `mid` / `did` / `iat` were never checked. `iat` / `exp` must be safe integers (epoch ms); `mid` / `did` / `jti` / `aud` must be non-empty strings. Every in-repo producer mints through `mintAudienceToken`, which always sets all six, so no conforming token changes verdict. Sibling relay change: `dispute-filer-authority-ignored.md`.
