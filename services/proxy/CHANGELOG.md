# @motebit/proxy

## 0.1.16

### Patch Changes

- 5339efd: Doctrine correction: reframe Phase 1 Workstation pane as the **Reader**,
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

- Updated dependencies [bce38b7]
- Updated dependencies [9dc5421]
- Updated dependencies [1690469]
- Updated dependencies [d969e7c]
- Updated dependencies [009f56e]
- Updated dependencies [25b14fc]
- Updated dependencies [3539756]
- Updated dependencies [28c46dd]
- Updated dependencies [2d8b91a]
- Updated dependencies [f69d3fb]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [3747b7a]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
  - @motebit/crypto@1.0.0
