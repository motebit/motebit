---
"@motebit/relay": patch
---

**The relay refuses to start without a master token.** Every master-token gate was installed only when `MOTEBIT_API_TOKEN` was non-empty, so a relay booted without it served the memory, state, audit and goals exports and the admin fee and withdrawal dashboards, and accepted `POST /api/v1/admin/freeze`, with no authentication. `createSyncRelay` now throws when `apiToken` is missing or blank, and the production config builder throws on an unset or empty `MOTEBIT_API_TOKEN`, so the process exits before listening with a repair message. The only way to run open is the local-development opt-in `MOTEBIT_RELAY_INSECURE_NO_AUTH=1` (config `allowInsecureNoAuth: true`), which logs `relay.insecure_no_auth` at warn level and is refused under `NODE_ENV=production`. A route-table test now enumerates every `/api/v1/admin/*` handler from the router and requires 401 without credentials.
