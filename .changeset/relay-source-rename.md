---
"motebit": patch
---

Internal: workspace-private `@motebit/api` package and `services/api/` directory renamed to `@motebit/relay` and `services/relay/` for naming coherence with the rest of the codebase (CLI command `motebit relay up`, doctrine docs, README, and the published container at `ghcr.io/motebit/relay`).

Per `docs/doctrine/release-versioning.md`: "Patch = repaired promise. Same public contract, better implementation." The motebit CLI's commands, flags, exit codes, `~/.motebit/` layout, MCP server tool list, and federation handshake protocol are all unchanged. Only bundle-internal source organization moved — the inlined workspace package the tsup `noExternal: [/.*/]` config bundles into `motebit/dist/index.js` is now sourced from `services/relay/` instead of `services/api/`.

Operators upgrading from `motebit@1.1.0` see no behavioural difference. No env vars, no flags, no commands, no DB layout, no protocol surface changed.

The companion container release ships as `ghcr.io/motebit/relay:1.0.1` (cut as a `relay-v1.0.1` git tag in the same change). The relay's contract — HTTP endpoints, env vars, volume layout, federation handshake, wire formats — is byte-identical to `relay-v1.0.0` (which published only to the now-deprecated `ghcr.io/motebit/api` namespace). Only the registry pull URL and the OCI `image.title` label differ. Per the same release-versioning doctrine, "the dev contract moved is at most additive" — the registry path is not a contract break, and a major bump here would be a "phantom major" the doctrine explicitly warns against.

Explicitly unchanged for separate operational migrations: Fly.io app names (`motebit-sync`, `motebit-sync-stg`, `motebit-sync-stg-b` — DNS+federation-peer cutover required), Prometheus metric prefix (`motebit_api_*` — would orphan historical time-series), all CHANGELOG entries (historical record), `docs/drift-defenses.md` (incident history).
