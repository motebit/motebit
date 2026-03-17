# Motebit

<p align="center">
  <img src="social-preview.png" alt="Motebit — A sovereign agent runtime" width="100%">
</p>

<p align="center">
  <a href="https://github.com/motebit/motebit/actions/workflows/ci.yml"><img src="https://github.com/motebit/motebit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/create-motebit"><img src="https://img.shields.io/npm/v/create-motebit?label=create-motebit" alt="create-motebit"></a>
  <a href="https://www.npmjs.com/package/@motebit/sdk"><img src="https://img.shields.io/npm/v/@motebit/sdk?label=%40motebit%2Fsdk" alt="@motebit/sdk"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSL%201.1-blue" alt="License: BSL 1.1"></a>
  <a href="LICENSE-MIT"><img src="https://img.shields.io/badge/protocol-MIT-green" alt="Protocol: MIT"></a>
</p>

**A sovereign agent runtime.** Persistent identity, accumulated memory, earned trust, governed delegation — wrapped in a glass droplet that breathes.

Every AI agent today is a session. No identity that persists. No memory that compounds. No trust that accumulates. No proof of what it's done. Motebit is the missing layer: a complete runtime where the intelligence is pluggable but the identity is the asset.

39 packages. 144K lines of TypeScript. 3,000+ tests. [Foundation built in 26 days.](https://docs.motebit.com/docs/how-we-built-this)

|                | Agents today   | Motebit                                                           |
| -------------- | -------------- | ----------------------------------------------------------------- |
| **Identity**   | Session token  | Ed25519 keypair — persists across devices, providers, time        |
| **Memory**     | Context window | Semantic graph — compounds, decays, consolidates                  |
| **Trust**      | None           | Signed receipts — earned, algebraic, auditable                    |
| **Governance** | None           | Policy gate — fail-closed, sensitivity-aware, operator-controlled |
| **Proof**      | None           | Verifiable credentials — W3C VC 2.0, cryptographically signed     |

## What it is

A motebit is a droplet of intelligence under surface tension.

**Identity** — Ed25519 keypairs, `did:key` URIs, signed identity files. The agent can prove who it is to any service, any relay, any other agent. Not a session token — a cryptographic entity that exists across time and devices. Keys rotate via signed succession records — both old and new keys sign the transition, the `motebit_id` persists, and anyone can verify the chain without trusting an intermediary.

**Memory** — A semantic graph that compounds with use. Memories form during conversation, decay naturally over time, consolidate from episodic to semantic. The longer it runs, the more it knows. Curiosity targets emerge from the graph.

**Trust** — Agents earn trust through verified interactions. Signed execution receipts create an immutable audit trail. Trust levels transition as collaboration succeeds or fails. A semiring algebra routes tasks through the most trusted paths in the agent network.

**Governance** — Policy gates control what crosses the boundary. Tool approval, budget limits, sensitivity-aware privacy, deletion certificates. Fail-closed by default. The operator decides what the agent can do autonomously, what requires approval, and what is always denied.

**Delegation** — Agents delegate tasks to other agents through MCP. Each delegation produces a self-verifiable signed receipt — the signer's public key is embedded, so any system can verify the receipt without contacting a relay. SHA-256 hashed prompt/result, nested delegation receipts for chain-of-custody, budget allocation and settlement on verified receipts.

**Embodiment** — A glass droplet rendered in Three.js. The body is passive; the interior is active. State drives behavior deterministically: curiosity dilates the eyes, mood curves the smile, processing brightens the glow. No stage directions — just physics.

**Federation** — Relays peer with each other through mutual authentication. Agents are discoverable across relays. Cross-relay routing uses the trust semiring to find optimal paths. Settlement chains handle cross-relay payment.

## Try it

```bash
# Meet the creature — zero install, zero signup
open https://motebit.com

# Or scaffold a signed agent identity (30 seconds)
npm create motebit@latest my-agent
cd my-agent && node verify.js

# Install the operator console
npm install -g motebit

# Start an interactive session
motebit

# Or run as a daemon with goal scheduling
motebit run --identity ./motebit.md
```

## Five surfaces

| Surface     | Purpose                                  | Entry point                                             |
| ----------- | ---------------------------------------- | ------------------------------------------------------- |
| **Web**     | Zero-friction first encounter            | [motebit.com](https://motebit.com)                      |
| **CLI**     | Developer console, operator mode, daemon | `npm install -g motebit`                                |
| **Desktop** | Tauri app — glass creature companion     | [Releases](https://github.com/motebit/motebit/releases) |
| **Mobile**  | React Native — travels with you          | Expo build                                              |
| **Spatial** | AR/VR — body-relative orbital mechanics  | WebXR prototype                                         |

Each surface maximizes what its platform offers. The web connects via HTTP MCP. The CLI operates. The desktop companions. Mobile travels. Spatial embodies. The anti-pattern is shimming platform-impossible capabilities.

## Architecture

```
apps/
  web/         Browser — IndexedDB identity, CORS proxy, glass creature
  cli/         Node.js — REPL, daemon, goal scheduling, operator console
  desktop/     Tauri — OS keyring, stdio MCP, full operator mode
  mobile/      React Native — Expo, secure keychain, triple providers
  admin/       React — 13-tab real-time monitoring dashboard
  spatial/     WebXR — 6DOF anchoring, spatial audio reactivity

packages/
  sdk/             Core types — zero deps, MIT licensed
  verify/          Signature verifier — zero deps, MIT licensed
  create-motebit/  Scaffolder — MIT licensed
  runtime/         Orchestrator — wires all engines, streaming AI loop
  ai-core/         Pluggable providers: Claude, Ollama, Hybrid fallback
  crypto/          Ed25519, AES-256-GCM, PBKDF2, W3C VC 2.0 credentials, signed succession
  memory-graph/    Semantic memory, cosine similarity, half-life decay
  event-log/       Append-only event sourcing, version clocks, compaction
  state-vector/    9-field interior state, EMA smoothing, hysteresis
  behavior-engine/ State → BehaviorCues, deterministic, species-constrained
  policy/          PolicyGate, MemoryGovernor, injection defense, audit
  privacy-layer/   Sensitivity levels, retention rules, deletion certificates
  planner/         PlanEngine: goal decomposition, reflection, adjustment
  sync-engine/     Multi-device sync, HTTP/WebSocket, conflict detection
  market/          Budget allocation, settlement, reputation, graph routing
  semiring/        Trust algebra — generic semirings for network routing
  mcp-server/      Expose motebit as MCP server, bearer auth, synthetic tools
  mcp-client/      MCP client, tool discovery, manifest pinning
  render-engine/   Glass droplet: MeshPhysicalMaterial, breathing, sag, glow
  ...              39 packages total

services/
  api/         Sync relay — device auth, receipt verification, budget settlement,
               credential issuance, federation, 5-tier rate limiting

spec/
  identity-v1.md          motebit/identity@1.0
  execution-ledger-v1.md  motebit/execution-ledger@1.0
  relay-federation-v1.md  motebit/relay-federation@1.0
```

## SDK

```typescript
import { verify } from "@motebit/verify";
import { readFileSync } from "node:fs";

const result = await verify(readFileSync("motebit.md", "utf-8"));
if (result.valid) {
  console.log(result.identity.motebit_id);
  console.log(result.did); // did:key:z6Mk...
  console.log(result.identity.governance.trust_mode);
}
```

```typescript
import type { ExecutionReceipt, MotebitState, AgentTrustRecord } from "@motebit/sdk";
```

Four npm packages, all zero monorepo dependencies:

| Package                                                            | Description                                       | License |
| ------------------------------------------------------------------ | ------------------------------------------------- | ------- |
| [`create-motebit`](https://www.npmjs.com/package/create-motebit)   | `npm create motebit` — scaffold a signed identity | MIT     |
| [`motebit`](https://www.npmjs.com/package/motebit)                 | CLI — REPL, daemon, operator console              | BSL-1.1 |
| [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) | Signature verification — zero dependencies        | MIT     |
| [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk)       | Protocol types — zero dependencies                | MIT     |

## Specification

> [!NOTE]
> **Motebit is a protocol first.** The `motebit.md` identity file is an [open standard](spec/identity-v1.md) (MIT) that can be verified by any tool, with or without the motebit runtime. The [verification library](https://www.npmjs.com/package/@motebit/verify) is zero-dependency and MIT licensed.

A `motebit.md` declares identity (Ed25519 public key, agent ID, `did:key`), governance (trust mode, risk thresholds), privacy (sensitivity levels, retention rules), memory (decay parameters), registered devices, and key succession history (§3.8).

## Development

```bash
pnpm install           # Node >= 20, pnpm 9.15
pnpm run build         # Build all 39 packages
pnpm run test          # 3,000+ tests across 139 files
pnpm run typecheck     # Type-check all packages
pnpm run lint          # Lint all packages
```

## License

The **protocol layer** is MIT licensed — use it freely, build on it, implement the spec in any language:

- [`spec/`](spec/) — identity specification
- [`packages/verify/`](packages/verify/) — verification library
- [`packages/create-motebit/`](packages/create-motebit/) — CLI scaffolder
- [`packages/sdk/`](packages/sdk/) — core protocol types

The **platform implementation** is [BSL 1.1](LICENSE) — free to use, source-available, converts to MIT per-version after 4 years (2030-03-09).

"Motebit" is a trademark of Daniel Hakim. See [TRADEMARK.md](TRADEMARK.md).

## Links

- [motebit.com](https://motebit.com) — meet the creature
- [Documentation](https://docs.motebit.com) — guides, architecture, API reference
- [Specification](spec/identity-v1.md) — motebit/identity@1.0
- [npm](https://www.npmjs.com/org/motebit) — published packages
- [Discussions](https://github.com/motebit/motebit/discussions) — questions, ideas, show & tell
- [Bug reports](https://github.com/motebit/motebit/issues/new?template=bug_report.yml) — found something broken? let us know
- [Contributing](CONTRIBUTING.md) — how to contribute to motebit
