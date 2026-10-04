---
"@motebit/proxy": patch
"@motebit/browser-sandbox": patch
---

Proxy tokens are domain-separated from every other relay-signed artifact.

- `@motebit/proxy`: `parseProxyToken` verified the relay signature but never proved the signed bytes WERE a proxy token. The relay signs audience-bound bearer tokens (`mintAudienceToken`: browser-sandbox, `task:dispatch`, `mcp:call`) and public canonical-JSON records (transparency declaration, agent-revocation feed) with the same key, so any of them parsed as a proxy token; with `bal`/`exp` undefined every comparison was false, `admitSpend` computed `NaN` and admitted, and `model: "auto"` reached the upstream provider on the operator's key. `parseProxyToken` now accepts only the exact claim set `issueProxyToken` signs (`mid`, `bal`, `models`, `jti`, `iat`, `exp`) with exact types (non-empty strings, safe non-negative integer `bal`, safe integer `iat`/`exp`, `string[]` `models`) and no other claim; anything else is a 401 before any spend. `admitSpend` refuses a non-integer/negative balance and a non-numeric remaining balance (defense in depth). No wire change: genuine relay proxy tokens already have exactly this shape.
- `@motebit/browser-sandbox`: regression test only — a relay-signed proxy token (with or without a smuggled `aud`) never verifies as a sandbox token (`verifySignedToken` requires `suite` + `aud`).
