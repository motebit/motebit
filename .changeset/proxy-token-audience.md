---
"@motebit/protocol": minor
---

New `proxy:token` audience + `PROXY_TOKEN_AUDIENCE` constant in the closed `TokenAudience` registry. The relay's proxy-token mint route (`POST /api/v1/agents/:id/proxy-token`) issues a cloud-inference billing token carrying the agent's balance; it is now caller===:motebitId authed under this least-privilege audience, so a generic read token cannot be replayed to mint a spending credential (closes the 2026-07-07 unauthenticated-mint exposure).
