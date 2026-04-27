---
"create-motebit": patch
"motebit": minor
---

Scaffolded agents are now self-contained, and `--direct` mode produces a minimal tool surface.

A cold-walk of the published `create-motebit@1.1.2` against the README's "What you see:" block surfaced two architectural drifts that this changeset closes.

**`create-motebit` — agent identity is local, not global.** The `--agent` scaffold path now writes the encrypted private key to `<agent>/.motebit/config.json` instead of the operator's global `~/.motebit/`. The scaffolded entrypoint pins `MOTEBIT_CONFIG_DIR=<agent>/.motebit` on the spawned `motebit serve` so the runtime reads THIS agent's identity, not whatever sits at the operator's path. The agent directory becomes portable: copy it to another machine, set `MOTEBIT_PASSPHRASE`, run. The identity-clobber gate moves from "global ~/.motebit has an identity" to "this agent dir already has its own .motebit/config.json" — same safety property, scoped correctly. `.gitignore` template now excludes `.motebit/` since it carries the encrypted key.

**`motebit` — `CONFIG_DIR` honours `MOTEBIT_CONFIG_DIR`.** The runtime previously hardcoded `~/.motebit/`; it now reads `process.env["MOTEBIT_CONFIG_DIR"]` first and falls back to `~/.motebit/` when unset. Operator usage (`motebit relay up`, `motebit run`, etc.) doesn't set the env var, so behavior is unchanged for them. The scaffolded-agent flow above sets it explicitly.

**`motebit` — `--direct` skips runtime-injected builtin tools.** `buildToolRegistry` previously registered ~12 builtins (memory, fs, web search, time, ...) regardless of mode. With `--direct`, the user has declared "no AI loop, run only my tools" — injecting builtins on top of that breaks the principle of least surprise and means a freshly scaffolded agent advertises a 12-tool MCP surface where the README claims 2. The factory now returns an empty registry when `config.direct` is true; the daemon's `--tools <path>` loader is the only thing that adds entries. Operator console doesn't pass `--direct`, so it keeps all builtins.

**Existing 1.1.2-scaffolded agents continue to work** — their identity sits in `~/.motebit` and the runtime's fallback resolves there when the env var is unset. New scaffolds use the local pattern. The two coexist; no migration required for in-the-wild agents.

**Verified end-to-end** with a clean-dir cold-walk: scaffold succeeds, `.motebit/` lands in the agent dir, global `~/.motebit/config.json` mtime untouched, `npm run dev` produces output that matches the README's "What you see:" block exactly:

```
Identity: 019d...
Tool loaded: fetch_url
Tool loaded: echo
Agent task handler enabled (direct mode — no LLM)
Tools loaded: fetch_url, echo
MCP server running on http://localhost:3100 (StreamableHTTP). 2 tools exposed.
Policy: ambient mode.
```

The third drift surfaced by the cold-walk — `Registered with relay: 401` — is relay-side and tracked separately.
