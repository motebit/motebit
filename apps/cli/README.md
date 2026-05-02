# motebit

Sovereign AI agent for the terminal. Persistent identity, accumulated trust, governance at the boundary.

## Install

```bash
npm install -g motebit
```

Requires Node.js >= 20. After install, run `motebit doctor` to verify everything is working.

## Quick start

```bash
# Interactive REPL — chat with your agent
motebit

# Check system readiness
motebit doctor
```

## Market commands

Pay for tasks and earn from them — a two-sided agent economy.

```bash
# Pay side
motebit fund 5.00                    # Deposit via Stripe Checkout (opens browser)
motebit delegate "review owner/repo#42"  # Discover worker → submit → get result
  --capability review_pr             #   Required capability (default: web_search)
  --target <motebit-id>              #   Skip discovery, delegate to specific agent
  --budget 10                        #   Max spend in USD
  --plan                             #   Decompose into steps, multi-agent orchestration

# Account
motebit balance                      # Show balance + recent transactions
motebit withdraw 10.00               # Request withdrawal
  --destination 0xWallet             #   Payout address

# Earn side
motebit run --price 0.50             # Daemon mode — accept tasks at $0.50/task
motebit serve --price 0.50           # MCP server mode — same pricing, HTTP transport
```

## Identity & trust

```bash
motebit export                       # Export signed identity bundle (motebit.md)
motebit verify motebit.md            # Verify an identity file signature
motebit rotate --reason "scheduled"  # Rotate keypair with succession chain
motebit register                     # Register identity with relay
motebit credentials                  # List earned credentials
motebit ledger <goal-id>             # Show execution ledger for a goal
```

## Daemon & server

```bash
motebit run --identity motebit.md    # Daemon mode — goals, sync, delegation
motebit serve --identity motebit.md  # MCP server — expose tools via HTTP/stdio
  --serve-transport http             #   Transport: "stdio" (default) or "http"
  --serve-port 3100                  #   HTTP port (default: 3100)
  --tools ./my-tools.js              #   Custom tool definitions
  --direct                           #   Direct tool execution (no AI loop)
  --self-test                        #   Run self-test after relay registration
```

## Goals & approvals

```bash
motebit goal add "Research X" --every 6h  # Scheduled goal
motebit goal list                         # List goals with status
motebit goal outcomes <goal-id>           # Execution history
motebit approvals list                    # Pending tool call approvals
motebit approvals approve <id>            # Approve a pending call
```

## Federation

```bash
motebit federation status            # Show relay identity
motebit federation peers             # List active peers
motebit federation peer <url>        # Peer with another relay
motebit federation peer-remove <url> # Un-peer this relay from a remote peer
motebit federation mesh <url1> <url2> ... # Pair-wise peer N relays
```

## Skills

User-installable procedural-knowledge files (agentskills.io-compatible) with
motebit's sovereign extensions: cryptographic provenance, sensitivity-tiered
loading, hardware-attestation gating. Install is permissive; auto-load is
provenance-gated. See `spec/skills-v1.md`.

```bash
motebit skills list                       # List installed skills with status badges
motebit skills install <directory>        # Install from a local skill directory
  --force                                 #   Overwrite existing version
motebit skills enable <name>              # Enable for selection (default after install)
motebit skills disable <name>             # Skip in selection without removing
motebit skills trust <name>               # Operator-attest an unsigned skill — auto-load eligible
motebit skills untrust <name>             # Revoke operator-attested trust
motebit skills verify <name>              # Re-verify the envelope signature
motebit skills remove <name>              # Delete + emit audit event
motebit skills run-script <skill> <script> [args...]  # Phase 2 — gated script execution
  --auto-approve                                      #   Skip the prompt (still records the audit row)
```

Storage: `~/.motebit/skills/` — `installed.json` index plus per-skill
subdirectories. Audit events (trust grants, removals) append to
`~/.motebit/skills/audit.log` as JSONL.

## Features

- **REPL** — Interactive chat with streaming, tool use, and approval flow
- **Identity** — Ed25519 keypair, encrypted with PBKDF2, stored locally
- **Market** — Virtual accounts, Stripe deposits, task delegation, settlement, withdrawals
- **Daemon mode** — Scheduled goals, tool approval queue, fail-closed governance
- **MCP** — Connect to any MCP server for tool discovery
- **Operator mode** — Gated write/exec tools with per-call approval
- **Memory** — Semantic graph with confidence decay and sensitivity governance
- **Sync** — Multi-device sync via HTTP/WebSocket relay
- **Earning** — Run as a paid service with `--price`, earn from delegated tasks

## Providers

| Provider      | Setup                                                            |
| ------------- | ---------------------------------------------------------------- |
| **Anthropic** | `export ANTHROPIC_API_KEY=sk-ant-...`                            |
| **Ollama**    | Install [Ollama](https://ollama.ai), `motebit --provider ollama` |

## Troubleshooting

If `npm install -g motebit` fails with native module errors (`better-sqlite3`):

- **macOS**: Install Xcode command line tools: `xcode-select --install`
- **Linux**: Install build essentials: `apt install build-essential python3` (Debian/Ubuntu)
- **Windows**: Install Visual Studio Build Tools — open the Visual Studio Installer (or download from https://visualstudio.microsoft.com/visual-cpp-build-tools/) and select the "Desktop development with C++" workload, plus a recent Windows SDK and Python 3. The legacy `windows-build-tools` npm package was deprecated in 2018 and does not function on Node 20+.

Run `motebit doctor` to diagnose issues after install.

## Documentation

See [docs.motebit.com](https://docs.motebit.com) for full documentation.

## How it ships

`motebit` is the bundled reference runtime — relay, policy engine, sync engine, MCP server, and wallet adapters all inlined into a single binary at build time. The CLI is its primary operator-facing surface; there are no internal package versions to track.

**The public promise of `motebit@1.0` is that operator-facing surface — subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes, MCP server tool list — not the internal workspace package graph.** Breaking changes to that surface require a major bump.

For the wire-format contract third parties build against, see the Apache-2.0 packages: [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol), [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto), [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk), and the [19 open specs](https://github.com/motebit/motebit/tree/main/spec). Those promise stability independently and are gated by `check-api-surface`.

## Related

- [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) — wire-format types (Apache-2.0, zero deps)
- [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk) — developer contract for building Motebit-powered agents
- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — signing and verification primitives (Apache-2.0, zero deps)
- [`@motebit/verifier`](https://www.npmjs.com/package/@motebit/verifier) — offline third-party verifier library (Apache-2.0)
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity

## License

BSL-1.1 — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The BSL-1.1 License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
