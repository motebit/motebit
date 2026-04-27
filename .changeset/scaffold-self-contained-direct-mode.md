---
"create-motebit": patch
"motebit": minor
---

Scaffolded agents are now self-contained, and `--direct` mode produces a minimal tool surface.

A cold-walk of the published `create-motebit@1.1.2` against the README's "What you see:" block surfaced two architectural drifts that this changeset closes.

**`create-motebit` — agent identity is local, not global.** The `--agent` scaffold path now writes the encrypted private key to `<agent>/.motebit/config.json` instead of the operator's global `~/.motebit/`. The scaffolded entrypoint pins `MOTEBIT_CONFIG_DIR=<agent>/.motebit` on the spawned `motebit serve` so the runtime reads THIS agent's identity, not whatever sits at the operator's path. The agent directory becomes portable: copy it to another machine, set `MOTEBIT_PASSPHRASE`, run. The identity-clobber gate moves from "global ~/.motebit has an identity" to "this agent dir already has its own .motebit/config.json" — same safety property, scoped correctly. `.gitignore` template now excludes `.motebit/` since it carries the encrypted key.

**`motebit` — `CONFIG_DIR` honours `MOTEBIT_CONFIG_DIR`.** The runtime previously hardcoded `~/.motebit/`; it now reads `process.env["MOTEBIT_CONFIG_DIR"]` first and falls back to `~/.motebit/` when unset. Operator usage (`motebit relay up`, `motebit run`, etc.) doesn't set the env var, so behavior is unchanged for them. The scaffolded-agent flow above sets it explicitly.

**`motebit` — `--direct` skips runtime-injected builtin tools.** `buildToolRegistry` previously registered ~12 builtins (memory, fs, web search, time, ...) regardless of mode. With `--direct`, the user has declared "no AI loop, run only my tools" — injecting builtins on top of that breaks the principle of least surprise and means a freshly scaffolded agent advertises a 12-tool MCP surface where the README claims 2. The factory now returns an empty registry when `config.direct` is true; the daemon's `--tools <path>` loader is the only thing that adds entries. Operator console doesn't pass `--direct`, so it keeps all builtins.

**`create-motebit` — onboarding chain actually loads `.env` at runtime.** The scaffolded `package.json`'s `dev`/`start`/`self-test` scripts now use `node --env-file=.env` (Node ≥ 20.6 native, no dependency added). Without this flag, the `.env` file the user creates from `.env.example` was wallpaper — Node never read it, so `MOTEBIT_PASSPHRASE` set there never reached the runtime, decrypt failed, `motebit_task` stayed disabled. The `.env.example` template's `MOTEBIT_PASSPHRASE` field now leads with a `REQUIRED` comment naming the failure mode. Scaffold success message and the per-agent README's "First run" snippet both call out the passphrase step explicitly. Engines floor moved to `>=20.6.0` so npm warns at install time when Node is too old.

**Existing 1.1.2-scaffolded agents continue to work** — their identity sits in `~/.motebit` and the runtime's fallback resolves there when the env var is unset. New scaffolds use the local pattern. The two coexist; no migration required for in-the-wild agents. (1.1.2-scaffolded agents that lacked the `--env-file=.env` flag will continue to expect `MOTEBIT_PASSPHRASE` in the shell rather than `.env` — same as before; this fix improves only newly-scaffolded agents.)

**Migration note (motebit @ minor bump).** `--direct` mode previously exposed a runtime tool registry of ~12 builtins (memory, fs, web search, time, ...). That surface was an accident of `buildToolRegistry` running unconditionally — never documented in the README, never appeared in `--help`, never specified. `--direct` now returns an empty registry; the only tools an agent in direct mode sees are those it loaded explicitly via `--tools <path>`. If you were unwittingly relying on the old 12-tool surface, drop `--direct` to run with the full AI-loop runtime (which keeps all builtins, including write/exec tools when `--operator` is also set).

**Verified end-to-end** with a _user-following-README_ cold-walk (no shell env exports beyond `MOTEBIT_PASSPHRASE` at scaffold creation; `cp .env.example .env`, edit passphrase value in `.env`, `npm run dev`): scaffold succeeds, `.motebit/` lands in the agent dir, global `~/.motebit/config.json` mtime untouched, `npm run dev` produces output that matches the README's "What you see:" block exactly:

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
