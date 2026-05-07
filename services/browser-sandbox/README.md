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
  The reaper skips sessions with in-flight actions, so a slow action
  whose runtime exceeds the idle window is not torn down
  mid-execution.
- **Single-tenant deployment boundary.** v1 auth is one shared bearer
  token (`MOTEBIT_API_TOKEN`) across all callers. Session IDs are
  128-bit random and unguessable, but the shared bearer is **not** a
  per-motebit cryptographic authorization layer — anyone holding the
  token plus a valid session id can act on that session. Practical
  isolation in v1 rests on session-id obscurity + transport-layer
  trust, not cryptographic per-motebit scoping.

  **Operational rule:** until audience-bound, per-motebit signed
  tokens land (the relay's `aud: "browser-sandbox"` model with a
  `motebit_id` claim), run **one service per motebit** — or per
  same-operator deployment — and treat the service as a single-tenant
  boundary. Multi-tenant production exposure is gated on the JWT
  graduation, not on slice 3's web wiring.

## Where to read more

- `docs/doctrine/motebit-computer.md` — embodiment doctrine,
  `virtual_browser` mode contract.
- `spec/computer-use-v1.md` §8.1 — wire format binding for the
  cloud-browser dispatcher.
- `packages/runtime/src/cloud-browser-dispatcher.ts` — the
  consumer-side dispatcher that talks to this service.
