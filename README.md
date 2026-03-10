# Motebit

<p align="center">
  <img src="social-preview.png" alt="Motebit — Cryptographic identity for AI agents" width="100%">
</p>

<p align="center">
  <a href="https://github.com/motebit/motebit/actions/workflows/ci.yml"><img src="https://github.com/motebit/motebit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/create-motebit"><img src="https://img.shields.io/npm/v/create-motebit" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSL%201.1-blue" alt="License: BSL 1.1"></a>
  <a href="LICENSE-MIT"><img src="https://img.shields.io/badge/protocol-MIT-green" alt="License: MIT"></a>
</p>

Cryptographic identity for AI agents.

Every AI agent today is a session — no persistent identity, no memory that compounds, no trust history, no proof of who it is. Motebit is the missing layer: Ed25519 keypairs, signed identity files, governance policy, and portable memory that travel with the agent across devices, providers, and time.

MCP defines what tools an agent can reach. Motebit defines **who the agent is**.

## Quick start

```bash
npm create motebit my-agent
cd my-agent
npm install
node verify.js
```

Four commands. Thirty seconds. A cryptographically signed agent identity on your filesystem.

## What you get

```
my-agent/
  motebit.md       Signed agent identity (Ed25519)
  verify.js        Verification example
  package.json     Node project with @motebit/verify
  .env.example     Environment variable template
  .gitignore       Secrets excluded
```

The `motebit.md` file is human-readable YAML frontmatter signed with Ed25519. Any tool can verify it:

```typescript
import { verify } from "@motebit/verify";
import { readFileSync } from "node:fs";

const result = await verify(readFileSync("motebit.md", "utf-8"));

if (result.valid) {
  console.log(result.identity.motebit_id);
  console.log(result.identity.governance.trust_mode);
}
```

## Packages

| Package                                                            | Description                           | License |
| ------------------------------------------------------------------ | ------------------------------------- | ------- |
| [`create-motebit`](https://www.npmjs.com/package/create-motebit)   | CLI scaffolder — `npm create motebit` | MIT     |
| [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) | Signature verification library        | MIT     |

## Specification

[**motebit/identity@1.0**](spec/identity-v1.md) — the open specification for agent identity files.

A `motebit.md` declares:

- **Identity** — Ed25519 public key, unique agent ID
- **Governance** — trust mode, risk thresholds, operator controls
- **Privacy** — sensitivity levels, retention rules, fail-closed defaults
- **Memory** — decay parameters, confidence thresholds
- **Devices** — registered device keys for multi-device sync

The spec is MIT licensed. Anyone can implement it.

## How it works

1. **Create** — `npm create motebit` generates an Ed25519 keypair, signs a `motebit.md` identity file, and encrypts the private key with your passphrase
2. **Verify** — any tool can verify the signature using `@motebit/verify` or the spec's 8-step algorithm
3. **Accumulate** — the identity persists across sessions. Memory, trust, and governance compound over time
4. **Delegate** — agents sign tasks and hand them to services with cryptographic proof of who asked

## Why

The agentic economy is missing plumbing. Not more intelligence — we have plenty of that. It needs identity, trust, and governance. The boring, load-bearing infrastructure that lets agents prove who they are, remember what they've done, and enforce policy about what crosses the boundary.

The intelligence is a commodity. The identity is the asset.

## Community

- [GitHub Discussions](https://github.com/motebit/motebit/discussions) — questions, ideas, show & tell
- [Bug reports](https://github.com/motebit/motebit/issues/new?template=bug_report.yml) — something broken? file it here
- [Feature requests](https://github.com/motebit/motebit/issues/new?template=feature_request.yml) — propose new capabilities
- [Contributing guide](CONTRIBUTING.md) — how to get involved

## License

The protocol layer is MIT licensed:

- [`spec/`](spec/) — identity specification
- [`packages/verify/`](packages/verify/) — verification library
- [`packages/create-motebit/`](packages/create-motebit/) — CLI scaffolder
- [`packages/sdk/`](packages/sdk/) — core types

The platform implementation is [BSL 1.1](LICENSE) — free to use, source-available, converts to MIT per-version after 4 years.

"Motebit" is a trademark of Daniel Hakim. The MIT License grants rights to the software, not to Motebit trademarks, logos, or branding.
