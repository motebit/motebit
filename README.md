# Motebit

<p align="center">
  <img src="social-preview.png" alt="Motebit — Cryptographic identity for AI agents" width="100%">
</p>

<p align="center">
  <a href="https://github.com/motebit/motebit/actions/workflows/ci.yml"><img src="https://github.com/motebit/motebit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/create-motebit"><img src="https://img.shields.io/npm/v/create-motebit?label=create-motebit" alt="create-motebit"></a>
  <a href="https://www.npmjs.com/package/@motebit/sdk"><img src="https://img.shields.io/npm/v/@motebit/sdk?label=%40motebit%2Fsdk" alt="@motebit/sdk"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSL%201.1-blue" alt="License: BSL 1.1"></a>
  <a href="LICENSE-MIT"><img src="https://img.shields.io/badge/protocol-MIT-green" alt="Protocol: MIT"></a>
</p>

**Cryptographic identity for AI agents.**

Every AI agent today is a session — no persistent identity, no memory that compounds, no trust history, no proof of who it is. Motebit is the missing layer: Ed25519 keypairs, signed identity files, governance policy, and portable memory that travel with the agent across devices, providers, and time.

MCP defines what tools an agent can reach. Motebit defines **who the agent is**.

## Why

Three things no one else is building together:

- **Persistent sovereign identity** — not a session token. An Ed25519 keypair that anchors an agent across devices, providers, and time. A `motebit.md` file that any tool can verify.
- **Accumulated trust** — memory that compounds with use and fades naturally with time. Signed execution receipts. Trust levels that update as agents collaborate. The longer it runs, the more capable it becomes.
- **Governance at the boundary** — sensitivity-aware policy gates that control what the agent can do autonomously, what requires approval, and what is always denied. Fail-closed by default.

## Quickstart

```bash
# Scaffold a signed agent identity (30 seconds)
npm create motebit@latest my-agent
cd my-agent

# Verify the signature
node verify.js

# Install the CLI
npm install -g motebit

# Start an interactive REPL session
motebit

# Or run as a background daemon with goal scheduling
motebit run --identity ./motebit.md
```

The scaffolded `motebit.md` is a human-readable identity file signed with Ed25519. It declares governance policy, memory parameters, privacy rules, and device registrations. Any tool can verify it — no motebit runtime required.

## SDK

```typescript
import { verify } from "@motebit/verify";
import { readFileSync } from "node:fs";

// Verify a motebit identity file
const result = await verify(readFileSync("motebit.md", "utf-8"));
if (result.valid) {
  console.log(result.identity.motebit_id); // 0195a8f2-...
  console.log(result.did); // did:key:z6Mk...
  console.log(result.identity.governance.trust_mode);
}
```

```typescript
import type { ExecutionReceipt, AgentTask, MotebitState } from "@motebit/sdk";

// Types for building on the motebit protocol
const receipt: ExecutionReceipt = {
  task_id: "...",
  motebit_id: "...",
  // Ed25519 signature over canonical JSON of prompt_hash + result_hash
  signature: "...",
  // ...
};
```

## Architecture

```
apps/
  desktop/     Tauri app — glass droplet creature, full identity/crypto/operator mode
  cli/         Node.js REPL and daemon — developer console, goal scheduling
  mobile/      React Native + Expo — full-featured mobile companion
  admin/       React dashboard — 11-tab real-time monitoring
  web/         Browser app — zero-install entry point, IndexedDB identity

packages/
  runtime/         MotebitRuntime — wires all engines, streaming AI loop
  ai-core/         Pluggable providers: Anthropic, Ollama, Hybrid fallback
  crypto/          Ed25519 signing, AES-256-GCM, PBKDF2, signed delegation tokens
  memory-graph/    Semantic memory with cosine similarity, half-life decay
  policy/          PolicyGate: tool approval, budgets, audit, injection defense
  planner/         PlanEngine: goal decomposition, reflection, plan adjustment
  sync-engine/     Multi-device sync: HTTP/WebSocket, conflict detection, backoff
  mcp-server/      Exposes motebit as an MCP server with bearer auth
  mcp-client/      MCP client: tool discovery, manifest pinning, EXTERNAL_DATA boundary
  sdk/             Core protocol types — zero deps, MIT licensed
  verify/          Standalone signature verifier — zero deps, MIT licensed
  create-motebit/  `npm create motebit` scaffolder — MIT licensed

services/
  api/         Sync relay: REST + WebSocket, Ed25519 device auth, event fan-out
  web-search/  Reference service motebit: proves the full discover→delegate→receipt loop

spec/
  identity-v1.md   Open specification for the motebit identity file format
```

The full architecture is documented at [docs.motebit.com](https://docs.motebit.com).

## Packages

| Package                                                            | Description                                              | Version                                                                                               | License |
| ------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| [`create-motebit`](https://www.npmjs.com/package/create-motebit)   | `npm create motebit` — scaffolds a signed agent identity | [![npm](https://img.shields.io/npm/v/create-motebit)](https://www.npmjs.com/package/create-motebit)   | MIT     |
| [`motebit`](https://www.npmjs.com/package/motebit)                 | CLI — REPL, daemon, goal scheduling, operator console    | [![npm](https://img.shields.io/npm/v/motebit)](https://www.npmjs.com/package/motebit)                 | BSL-1.1 |
| [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) | Signature verification library — zero dependencies       | [![npm](https://img.shields.io/npm/v/@motebit/verify)](https://www.npmjs.com/package/@motebit/verify) | MIT     |
| [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk)       | Core protocol types — zero dependencies                  | [![npm](https://img.shields.io/npm/v/@motebit/sdk)](https://www.npmjs.com/package/@motebit/sdk)       | MIT     |

## Specification

[**motebit/identity@1.0**](spec/identity-v1.md) — the open specification for agent identity files. MIT licensed. Anyone can implement it.

A `motebit.md` declares identity (Ed25519 public key, unique agent ID, W3C `did:key`), governance (trust mode, risk thresholds), privacy (sensitivity levels, retention rules), memory (decay parameters), and registered devices.

## Development

```bash
# Prerequisites: Node >= 20, pnpm 9.15
pnpm install

pnpm run build       # Build all packages
pnpm run test        # Run all tests (~2,100 across 30+ files)
pnpm run typecheck   # Type-check all packages (59 targets)
pnpm run lint        # Lint all packages

# Single package
pnpm --filter @motebit/runtime build
pnpm --filter @motebit/runtime test
```

## License

The **protocol layer** is MIT licensed — use it freely, build on it, implement the spec in any language:

- [`spec/`](spec/) — identity specification
- [`packages/verify/`](packages/verify/) — verification library
- [`packages/create-motebit/`](packages/create-motebit/) — CLI scaffolder
- [`packages/sdk/`](packages/sdk/) — core protocol types

The **platform implementation** is [BSL 1.1](LICENSE) — free to use, source-available, converts to MIT per-version after 4 years (2030-03-09).

"Motebit" is a trademark of Daniel Hakim. See [TRADEMARK.md](TRADEMARK.md) for the full policy.

## Links

- [Documentation](https://docs.motebit.com) — guides, architecture, API reference
- [Specification](spec/identity-v1.md) — motebit/identity@1.0
- [npm](https://www.npmjs.com/org/motebit) — published packages
- [GitHub Discussions](https://github.com/motebit/motebit/discussions) — questions, ideas, show & tell
- [Bug reports](https://github.com/motebit/motebit/issues/new?template=bug_report.yml)
- [Contributing](CONTRIBUTING.md)
