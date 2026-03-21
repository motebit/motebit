# motebit CLI Changelog

## 0.5.1

### Patch Changes

- [`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

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
