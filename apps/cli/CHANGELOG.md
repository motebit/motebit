# motebit CLI Changelog

All notable changes to the `motebit` CLI are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.3.0] - 2026-03-13

### Added

- `motebit id` subcommand — display identity card (motebit_id, did:key, public key, device)
- `motebit credentials` subcommand — list and inspect W3C Verifiable Credentials
- `motebit ledger <goalId>` subcommand — view execution ledger for a goal
- `/graph` command — memory graph health summary
- `/curious` command — show fading memories the agent has noticed
- `/agents` enhanced — trust levels, Beta-binomial reputation, task history
- Intelligence gradient display in `/state`
- Curiosity-driven memory maintenance during conversations
- `motebit export` expanded — writes full bundle directory (identity + credentials + presentation + budget + gradient)
- `motebit verify <dir>` expanded — validates identity files, VC proofs, VP integrity, and bundle cross-references

## [0.2.0] - 2026-03-10

### Added

- Published to npm as `motebit`
- REPL chat, daemon mode, operator console, MCP server mode
- Subcommands: `id`, `export`, `verify`, `run`, `goal`, `approvals`
- Slash commands: `/model`, `/memories`, `/graph`, `/curious`, `/state`, `/forget`, `/export`, `/sync`, `/clear`, `/tools`, `/mcp`, `/agents`, `/operator`, `/help`, `/summarize`, `/conversations`, `/conversation`, `/goals`, `/goal`, `/approvals`, `/reflect`, `/discover`
- MCP server mode (`motebit --serve`) with stdio and HTTP transport
