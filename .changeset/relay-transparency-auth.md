---
"@motebit/relay": patch
---

Gate `GET /api/v1/admin/transparency` behind the master bearer (`bearerAuth({ token: apiToken })`). The endpoint always claimed (in its own JSDoc) to be audience-bound at the auth layer, but no middleware was ever wired for that path — it shipped as a wide-open endpoint returning operator-internal posture data. The public-facing transparency artifact is the signed `/.well-known/motebit-transparency.json` (still public, unchanged); third-party consumers verify offline against the signature, not via this endpoint.

Wired into the `expensiveLimiter` rate-limit tier alongside the rest of `/api/v1/admin/*`. New tests assert 401 without bearer, 200 with bearer, and the public well-known JSON stays reachable without auth.

Doctrine note in `docs/doctrine/operator-transparency.md` updated to reflect the gating.
