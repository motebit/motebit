---
"@motebit/web": patch
---

Skills v1 phase 4.4 — public registry browser at `motebit.com/skills`.

URL-driven entry: visiting `/skills` opens the panel; closing pops back to `/`. No HUD button — the registry is primarily a public-facing browse surface for external visitors, and the existing motebit user IA stays uncluttered. Browser back/forward navigation works the way users expect (popstate handler keeps panel state in sync with the URL).

The panel consumes the relay's public-read registry endpoints:

- `GET /api/v1/skills/discover` — paginated list, default-curated (featured submitters only). The `show all` toggle re-queries with `include_unfeatured=true` for full transparency.
- `GET /api/v1/skills/:submitter/:name/:version` — full bundle for the detail view. Body is base64-decoded in-browser and rendered as preformatted markdown (a real renderer is a 4.4.x polish, not a 4.4 blocker).

Each detail view shows a copy-paste install command (`motebit skills install <did>/<name>@<version>`) so a visitor can land on `motebit.com/skills`, find a skill they want, copy the address, and install it in their existing CLI session. That's the carrier thesis as a workflow, not a thesis.

CORS works without configuration: relay's `corsOrigin` defaults to `*` (`services/relay/src/index.ts:302`), so browser fetches from any origin succeed. Public-read endpoints take no auth header.

Empty state degrades gracefully:

- Curated default + empty result → "No featured skills yet. Toggle `show all` to view every submission, or run `motebit skills publish skills/<name>`."
- `include_unfeatured=true` + empty result → "No skills published to this relay yet."
- Relay unreachable → "Could not reach the relay (https://relay.motebit.com). {error}."

Out of scope (deliberate, deferred to 4.4.x):

- Browser-side install (the CLI is the install surface; the browser is read-only-browse).
- Browser-side envelope re-verification — the existing `verifySkillEnvelope` from `@motebit/sdk` is pure JS via `@noble/ed25519` and would work in a browser bundle, but the v1 surface is browse-only. A "verify locally" button is a 4.4.x add.
- Search / sort / filter UI beyond passing query params through. The discover endpoint already supports `q`, `sensitivity`, `platform`, `submitter` filters — surfacing them in the UI is a v2 polish.

The browser surface joins the cross-surface coverage: CLI (install, publish), desktop (4.2 sidecar-isolated installed-skills panel), web (4.4 public registry browser). Mobile (4.3) is the remaining surface; native IPC will mirror the desktop sidecar boundary.
