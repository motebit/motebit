---
"@motebit/browser-sandbox": minor
---

v1.3 hardening — `navigate` action captures a screenshot inline and
returns it in the result, so the slab shows the page right after
navigation regardless of whether the live-screencast endpoint is
deployed.

Two earlier shipments composed into a regression: `navigate(url)` was
added with metadata-only return shape (`ok`, `visual_content_detected`,
etc., no bytes), and `bytes_omitted` was added so the AI stops
hallucinating screenshot content. The AI started skipping the
follow-up `screenshot` action — cheap to call, but the bytes wouldn't
be in its context anyway. The user's slab dutifully rendered the raw
JSON metadata because no inline frame was available.

`doNavigate` now captures `page.screenshot({ type: "jpeg", quality:
60 })` after the page-readiness heuristic and packs `bytes_base64 +
image_format + width + height + captured_at` into the result. JPEG
60% mirrors the screencast's quality register; PNG would be overkill
for a navigate snapshot. Capture failure is non-fatal — the metadata
fields still let the AI describe what happened, and the slab falls
through to the friendly fallback.

Privacy contract intact. The `bytes_omitted` projection in
`@motebit/ai-core`'s `projectForAi` was extended to catch
`kind: "navigate"` (companion changeset) so the AI never sees the
inline bytes — same self-instructive marker, same "user has the
image, you don't" directive.

Plus: `goto` timeout 30s → 15s, `networkidle` 5s → 2s. Cold-start
Chromium + 30s/5s ceiling stacked into ~30s wall-clock for fast
sites; the new ceiling is honest enough for any real first-paint and
fails fast when the page won't render.
