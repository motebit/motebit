# motebit CLI Changelog

All notable changes to the `motebit` CLI are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [Unreleased]

### Added

- `motebit id` subcommand — display identity card (motebit_id, did:key, public key, device)
- `/graph` command — memory graph health summary
- `/curious` command — show fading memories the agent has noticed
- `/agents` enhanced — trust levels, Beta-binomial reputation, task history
- Intelligence gradient display in `/state`
- Curiosity-driven memory maintenance during conversations

## [0.2.0] - 2026-03-10

### Added

- Published to npm as `motebit`
- REPL chat, daemon mode, operator console, MCP server mode
- Subcommands: `id`, `export`, `verify`, `run`, `goal`, `approvals`
- Slash commands: `/model`, `/memories`, `/graph`, `/curious`, `/state`, `/forget`, `/export`, `/sync`, `/clear`, `/tools`, `/mcp`, `/agents`, `/operator`, `/help`, `/summarize`, `/conversations`, `/conversation`, `/goals`, `/goal`, `/approvals`, `/reflect`, `/discover`
- MCP server mode (`motebit --serve`) with stdio and HTTP transport
