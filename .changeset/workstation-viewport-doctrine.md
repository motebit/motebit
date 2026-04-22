---
"@motebit/proxy": patch
---

Doctrine correction: reframe Phase 1 Workstation pane as the **Reader**,
not the browser. Computer use (desktop) ⊇ browser use (sandboxed
surfaces) ⊇ reader (AI tool). One viewport concept at three fidelities,
not three parallel features.

**New doctrine:** `docs/doctrine/workstation-viewport.md`. Per-surface
map:

- Desktop: full computer use (screen capture + OS input).
- Web/mobile/spatial: cloud-hosted browser (browser-subset, sandbox
  permitting).
- Reader: `read_url` text extraction — AI tool, distinct from the
  viewport. Stays as a tool after viewport modes ship.

**Proxy local-dev fix:** `services/proxy/src/app/v1/fetch/route.ts`
rate-limit no longer fails-closed when `KV_REST_API_URL` is absent —
that env var's absence is a reliable signal we're in local `next dev`
against localhost (production always sets it). Allowlisted origins
still gate who can call the route; this just unblocks the local Reader
path for development. Production `https://api.motebit.com` deploys
unchanged.

**Comment cleanup:** `apps/web/src/ui/workstation-panel.ts` +
`apps/desktop/src/ui/workstation-panel.ts` — stale "browser pane" /
"window to the internet" phrasing replaced with accurate "Reader pane"
framing, cross-referenced to the new doctrine. No behavior change.
