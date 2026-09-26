---
"@motebit/relay": patch
---

**`Retry-After` and `X-Motebit-Content-Manifest` are readable from a browser.** The relay's CORS middleware now sends `Access-Control-Expose-Headers: Retry-After, X-Motebit-Content-Manifest`. Neither header is CORS-safelisted, so page JavaScript in a browser or the Tauri webview read both as `null`: the web and desktop roster clients and `@motebit/runtime`'s relay-delegation error classifier never honoured a 429's back-off, and `@motebit/state-export-client` in a browser (desktop, inspector) saw no manifest on a signed state export. React Native's fetch was unaffected. The list is `CORS_EXPOSED_RESPONSE_HEADERS` in `middleware.ts`, named with its readers. It covers the rate limiter's 429, a `RateLimitError` reaching the error handler, and every other response.
