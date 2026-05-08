---
"@motebit/ai-core": patch
"@motebit/web": patch
---

v1.3 hardening — `navigate` action carries inline screenshot bytes;
both privacy projection and slab rendering must accept the new
shape.

`@motebit/ai-core`'s `projectForAi` now strips `bytes_base64` from
`kind: "navigate"` results in addition to `kind: "screenshot"`. Same
`bytes_omitted` self-instructive directive ("Image rendered on the
user's slab. Bytes withheld from your context… don't describe what
you can't see"). Without this, the AI's conversation history would
balloon with the base64 blob from every navigate call and the AI
might hallucinate page content from training data.

`apps/web`'s `extractScreenshot` accepts `kind: "navigate"` when
`bytes_base64` is present — same renderable payload shape, same
image card. A navigate result without bytes (capture-failure
fallback) returns null, so the slab falls through to the
friendly-fallback / generic renderer.

Tests:

- `loop.test.ts`: navigate-with-bytes scenario verifies AI history
  carries the marker, slab chunk carries the raw bytes verbatim.
  Sibling of the existing `screenshot result` test.
- `slab-items-screenshot.test.ts`: extractScreenshot accepts
  navigate-with-bytes, returns null for navigate-without-bytes.

All 69 drift gates green; loop + slab-items tests pass.
