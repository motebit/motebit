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

Auth: `Authorization: Bearer $MOTEBIT_API_TOKEN` on every authed
route.

## v1 limits

- One page per session (single tab).
- Concurrent-session cap (config-driven; default 4).
- Idle reaper closes forgotten sessions after `BROWSER_SANDBOX_IDLE_MS`.
- Single shared bearer token across motebits — multi-tenant
  isolation is a future graduation (audience-bound signed JWTs with
  `motebit_id` claim).

## Where to read more

- `docs/doctrine/motebit-computer.md` — embodiment doctrine,
  `virtual_browser` mode contract.
- `spec/computer-use-v1.md` §8.1 — wire format binding for the
  cloud-browser dispatcher.
- `packages/runtime/src/cloud-browser-dispatcher.ts` — the
  consumer-side dispatcher that talks to this service.
