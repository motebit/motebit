# motebit

Sovereign AI agent for the terminal. Persistent identity, accumulated trust, governance at the boundary.

## Install

```bash
npm install -g motebit
```

Requires Node.js >= 20. After install, run `motebit doctor` to verify everything is working.

## Quick start

```bash
# Check system readiness
motebit doctor

# Interactive REPL — chat with your agent
motebit

# Export a signed identity file
motebit export

# Verify an identity file
motebit verify motebit.md

# Run in daemon mode with scheduled goals
motebit run --identity motebit.md
```

## What is a motebit?

A motebit is a persistent, cryptographically-anchored agent — a vessel that connects to any intelligence provider, any tool ecosystem (MCP), and any device. The intelligence is a commodity. The identity, with its accumulated memory, trust, and governance, is the asset.

## Features

- **REPL** — Interactive chat with streaming, tool use, and approval flow
- **Identity** — Ed25519 keypair, encrypted with PBKDF2, stored locally
- **Daemon mode** — Scheduled goals, tool approval queue, fail-closed governance
- **MCP** — Connect to any MCP server for tool discovery
- **Operator mode** — Gated write/exec tools with per-call approval
- **Memory** — Semantic graph with confidence decay and sensitivity governance
- **Sync** — Multi-device sync via HTTP/WebSocket relay

## Providers

| Provider      | Setup                                                            |
| ------------- | ---------------------------------------------------------------- |
| **Anthropic** | `export ANTHROPIC_API_KEY=sk-ant-...`                            |
| **Ollama**    | Install [Ollama](https://ollama.ai), `motebit --provider ollama` |

## Troubleshooting

If `npm install -g motebit` fails with native module errors (`better-sqlite3`):

- **macOS**: Install Xcode command line tools: `xcode-select --install`
- **Linux**: Install build essentials: `apt install build-essential python3` (Debian/Ubuntu)
- **Windows**: Install windows-build-tools: `npm install -g windows-build-tools`

Run `motebit doctor` to diagnose issues after install.

## Documentation

See [motebit.dev](https://motebit.dev) for full documentation.

## License

Motebit Community License — see [LICENSE](./LICENSE).
