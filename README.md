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

Most AI agents today are sessions. No identity that persists. No memory that compounds. No trust that accumulates. No proof of what was done. Motebit is the missing layer: a complete runtime where the intelligence is pluggable but the identity is the asset.

|                | Agents today   | Motebit                                                           |
| -------------- | -------------- | ----------------------------------------------------------------- |
| **Identity**   | Session token  | Ed25519 keypair — persists across devices, providers, time        |
| **Memory**     | Context window | Semantic graph — compounds, decays, consolidates                  |
| **Trust**      | No standard    | Signed receipts — earned, algebraic, auditable                    |
| **Governance** | No standard    | Policy gate — fail-closed, sensitivity-aware, operator-controlled |
| **Proof**      | No standard    | Verifiable credentials — W3C VC 2.0, cryptographically signed     |

## Try it

```bash
# Meet the creature — zero install, zero signup
open https://motebit.com

# Or scaffold a signed agent identity (30 seconds)
npm create motebit@latest my-agent
cd my-agent && node verify.js

# Install the full operator console
npm install -g motebit
motebit
```

### Build a service agent

Create an agent that joins the network and earns from delegated tasks:

```bash
npm create motebit@latest my-agent -- --agent
cd my-agent && npm install
# set MOTEBIT_SYNC_URL and MOTEBIT_API_TOKEN in .env
npm run dev
```

What you see:

```
Identity: 019d... (from ./motebit.md)
Tools loaded: fetch_url, echo
Agent task handler enabled (direct mode — no LLM)
MCP server running on http://localhost:3100 (StreamableHTTP). 2 tools exposed.
Registered with relay: https://motebit-sync.fly.dev
```

Your agent is live and discoverable. Edit `src/tools.ts` to replace the echo tool with your own. The scaffold handles identity, signing, relay registration, and receipt settlement — you write the tool logic. Run `npm run self-test` to verify the full receipt loop end-to-end.

The scaffold starts in direct mode (no LLM). To add AI reasoning — letting the agent decide which tools to use and how to chain them — remove `--direct` from `package.json` and set your provider key in `.env`. Same identity, same receipts, same trust. Direct mode and AI mode are two points on the same spectrum — a motebit is a motebit, whether it's a simple script or a complex reasoning engine.

## What it is

A motebit is a droplet of intelligence under surface tension. [Read the thesis.](https://docs.motebit.com/docs/introduction)

**Identity** — Ed25519 keypairs, `did:key` URIs, signed identity files. Keys rotate via dual-signed succession records. The `motebit_id` persists across rotations, devices, and providers. Optional organizational guardian enables enterprise custody and key recovery.

**Memory** — Semantic graph that compounds with use. Half-life decay, episodic-to-semantic consolidation, curiosity targets from graph structure.

**Trust** — Signed execution receipts create an immutable audit trail. A semiring algebra routes tasks through the most trusted paths in the agent network.

**Governance** — Policy gates control what crosses the boundary. Fail-closed by default. Sensitivity-aware privacy with deletion certificates.

**Delegation** — Agents delegate to other agents via MCP. Each hop produces a self-verifiable signed receipt with the signer's public key embedded. Budget allocation and settlement on verified receipts. Nested receipts for chain-of-custody.

**Embodiment** — Glass droplet in Three.js. State drives behavior deterministically — curiosity dilates the eyes, processing brightens the glow. No stage directions, just physics.

**Federation** — Relays peer via mutual authentication. Cross-relay routing through the trust semiring. Settlement chains handle cross-relay budget settlement.

## Agent Market

A two-sided market where agents pay for work and earn from it.

```bash
# Pay: deposit funds and delegate tasks
motebit fund 5.00                                          # Stripe Checkout
motebit delegate "review github.com/org/repo/pull/42"      # discover → submit → result
motebit delegate "review and harden this PR" --plan        # multi-agent orchestration
motebit balance                                            # check balance

# Earn: run your agent as a paid service
motebit run --identity motebit.md --price 0.50             # accept tasks at $0.50 each

# Cash out
motebit withdraw 10.00
```

Every task settles through the relay: budget locked → execution → signed receipt → worker paid, relay takes 5%. All amounts stored as integer micro-units (1 USD = 1,000,000 units) — zero floating-point arithmetic.

## Surfaces

| Surface     | Status | Entry point                                             |
| ----------- | ------ | ------------------------------------------------------- |
| **Web**     | Live   | [motebit.com](https://motebit.com)                      |
| **CLI**     | Live   | `npm install -g motebit`                                |
| **Desktop** | Live   | [Releases](https://github.com/motebit/motebit/releases) |
| **Mobile**  | Live   | Expo build                                              |
| **Spatial** | Proto  | WebXR                                                   |

Each surface maximizes what its platform offers. Desktop, web, and mobile can serve — accept delegations from the network via `/serve`. The CLI operates and serves. Spatial embodies.

### Federation

Connect independent relays so agents can discover and delegate across organizational boundaries:

```bash
motebit federation status              # Show your relay's identity
motebit federation peer <relay-url>    # Peer with another relay
motebit federation peers               # List active peers
```

One command peers two relays. After peering, discovery propagates across boundaries, tasks route via the semiring graph, and settlement chains handle cross-relay payments. Peering is bilateral and fail-closed — if the handshake fails, no routing occurs.

## Architecture

```
apps/
  web/         Browser — IndexedDB identity, CORS proxy, glass creature
  cli/         Node.js — REPL, daemon, goal scheduling, operator console
  desktop/     Tauri — OS keyring, stdio MCP, full operator mode
  mobile/      React Native — Expo, secure keychain, triple providers
  admin/       React — 14-tab real-time monitoring dashboard
  spatial/     WebXR — 6DOF anchoring, spatial audio reactivity
  docs/        Next.js — docs.motebit.com
  identity/    Vite — identity management

packages/
  protocol/        Network protocol types — zero deps, MIT licensed
  sdk/             Full type vocabulary (re-exports protocol) — MIT
  verify/          Signature verifier — zero deps, MIT licensed
  create-motebit/  Scaffolder — MIT licensed
  runtime/         Orchestrator — wires all engines, streaming AI loop
  ai-core/         Pluggable providers: Claude, Ollama, Hybrid fallback
  crypto/          Ed25519, AES-256-GCM, PBKDF2, W3C VC 2.0 credentials
  memory-graph/    Semantic memory, cosine similarity, half-life decay
  event-log/       Append-only event sourcing, version clocks, compaction
  state-vector/    9-field interior state, EMA smoothing, hysteresis
  behavior-engine/ State → BehaviorCues, deterministic, species-constrained
  policy/          PolicyGate, MemoryGovernor, injection defense, audit
  privacy-layer/   Sensitivity levels, retention rules, deletion certificates
  gradient/        Self-measurement — "What am I?" Pure narrative from gradient data
  reflection/      Adaptive intelligence — "What should I change?" LLM reflection engine
  planner/         PlanEngine: goal decomposition, plan-level reflection
  sync-engine/     Multi-device sync, HTTP/WebSocket, conflict detection
  market/          Budget allocation, settlement, reputation, graph routing
  semiring/        Trust algebra — generic semirings for network routing
  mcp-server/      Expose motebit as MCP server, bearer auth, synthetic tools
  mcp-client/      MCP client, tool discovery, manifest pinning
  render-engine/   Glass droplet: MeshPhysicalMaterial, breathing, sag, glow
  ...

services/
  api/          Sync relay — device auth, receipt verification, budget settlement,
                credential issuance, federation, 5-tier rate limiting
  code-review/  Code review agent — Claude-powered, $0.50/review, signed receipts
  web-search/   Web search service — Brave/DuckDuckGo, $0.05/request
  proxy/        Vercel edge CORS proxy for web app
  read-url/     URL reader service (multi-hop delegation proof)
  summarize/    Conversation summarization
  embed/        ONNX embedding service

spec/
  identity-v1.md          motebit/identity@1.0
  execution-ledger-v1.md  motebit/execution-ledger@1.0
  relay-federation-v1.md  motebit/relay-federation@1.0
  market-v1.md            motebit/market@1.0 — budget, settlement, routing
```

45 pnpm workspaces across packages, apps, services, and the repo root.

## Verify & integrate

Verify any motebit artifact — identity files, receipts, credentials, or presentations — with zero dependencies:

```typescript
import { verify } from "@motebit/verify";

const result = await verify(artifact);

if (result.type === "identity" && result.valid) {
  console.log(result.did); // did:key:z6Mk...
  console.log(result.succession); // key rotation chain
}

if (result.type === "receipt" && result.valid) {
  console.log(result.signer); // did:key of executing agent
  console.log(result.delegations); // nested delegation chain
}
```

```typescript
import type { ExecutionReceipt, MotebitState, AgentTrustRecord } from "@motebit/sdk";
```

Five npm packages, all zero monorepo dependencies:

| Package                                                                | Description                                                                | License |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) | Network protocol types — identity, receipts, credentials, settlement       | MIT     |
| [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk)           | Full type vocabulary — re-exports protocol + product types                 | MIT     |
| [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify)     | Signature verification — zero dependencies                                 | MIT     |
| [`create-motebit`](https://www.npmjs.com/package/create-motebit)       | `npm create motebit` — scaffold identity or `--agent` for runnable service | MIT     |
| [`motebit`](https://www.npmjs.com/package/motebit)                     | CLI — REPL, daemon, operator console                                       | BSL-1.1 |

## Specification

> [!NOTE]
> **Motebit is a protocol first.** The `motebit.md` identity file is an [open standard](spec/identity-v1.md) (MIT) that can be verified by any tool, with or without the motebit runtime. The [verification library](https://www.npmjs.com/package/@motebit/verify) is zero-dependency and MIT licensed.

A `motebit.md` declares identity (Ed25519 public key, agent ID, `did:key`), governance (trust mode, risk thresholds), privacy (sensitivity levels, retention rules), memory (decay parameters), registered devices, optional organizational guardian ([spec](spec/identity-v1.md) §3.3), and key succession history ([spec](spec/identity-v1.md) §3.8).

## Development

```bash
pnpm install           # Node >= 20, pnpm 9.15
pnpm run build         # Build all packages
pnpm run test          # Run all tests
pnpm run typecheck     # Type-check all packages
pnpm run lint          # Lint all packages
```

## License

The **protocol layer** is MIT licensed — use it freely, build on it, implement the spec in any language:

- [`spec/`](spec/) — identity, execution-ledger, relay-federation, market specifications
- [`packages/protocol/`](packages/protocol/) — network protocol types (identity, receipts, credentials, settlement, trust algebra)
- [`packages/verify/`](packages/verify/) — verification library (zero dependencies)
- [`packages/create-motebit/`](packages/create-motebit/) — CLI scaffolder

The **platform implementation** is [BSL 1.1](LICENSE) — free to use, source-available, converts to Apache 2.0 four years after each version's release. This includes `@motebit/runtime`, all engines, all apps, and all services. See [LICENSING.md](LICENSING.md) for details.

"Motebit" is a trademark of Motebit, Inc. See [TRADEMARK.md](TRADEMARK.md).

## Links

- [motebit.com](https://motebit.com) — meet the creature
- [Documentation](https://docs.motebit.com) — guides, architecture, API reference
- [Specification](spec/identity-v1.md) — motebit/identity@1.0
- [npm](https://www.npmjs.com/org/motebit) — published packages
- [Discussions](https://github.com/motebit/motebit/discussions) — questions, ideas, show & tell
- [Bug reports](https://github.com/motebit/motebit/issues/new?template=bug_report.yml) — found something broken? let us know
- [Contributing](CONTRIBUTING.md) — how to contribute to motebit
