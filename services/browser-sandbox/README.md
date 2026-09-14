# `@motebit/browser-sandbox`

Cloud-hosted Chromium driving the `virtual_browser` embodiment via the
`computer-use-v1` wire format. Sibling to the desktop Tauri bridge —
both speak the same protocol; this one targets an isolated Chromium
sandbox instead of the user's real OS.

## Role

The second `ComputerPlatformDispatcher` producer. The runtime's
`CloudBrowserDispatcher` (in `@motebit/runtime`) connects here via
HTTP; every action / observation flows through the same wire format
the desktop bridge uses, the same governance hooks, the same signed
receipts. Promotes `motebit/computer-use@1.0` from `@alpha` to
`@beta` once exercising the format in anger.

## Endpoints

```
POST   /sessions/ensure          — open a new isolated session
POST   /sessions/:id/actions     — execute one ComputerAction
DELETE /sessions/:id             — tear down a session
GET    /health                   — liveness check (unauth)
```

Auth: `Authorization: Bearer <relay-signed sandbox token>` on every
authed route — an audience-bound token (`aud: "browser-sandbox"`) the
motebit's relay mints against the motebit's own signed grant, verified
here against the pinned `MOTEBIT_TRUSTED_RELAY_PUBKEY`. The v1 shared
bearer was retired 2026-09-14; there is no second path.

## v1 limits

- One page per session (single tab).
- Concurrent-session cap (config-driven; default 4).
- Idle reaper closes forgotten sessions after `BROWSER_SANDBOX_IDLE_MS`.
  The reaper skips sessions with in-flight actions, so a slow action
  whose runtime exceeds the idle window is not torn down
  mid-execution.
- **Per-motebit authorization.** Every request carries a relay-signed
  token whose `mid` claim names the calling motebit; a session belongs
  to the motebit that opened it. Session IDs are 128-bit random on top
  of that, never the only boundary.

## Where to read more

- `docs/doctrine/motebit-computer.md` — embodiment doctrine,
  `virtual_browser` mode contract.
- `spec/computer-use-v1.md` §8.1 — wire format binding for the
  cloud-browser dispatcher.
- `packages/runtime/src/cloud-browser-dispatcher.ts` — the
  consumer-side dispatcher that talks to this service.
