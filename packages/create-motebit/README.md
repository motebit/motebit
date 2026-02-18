# create-motebit

Create and verify `motebit.md` agent identity files — the [motebit/identity@1.0](../../spec/identity-v1.md) standard.

## Quick Start

```bash
npm create motebit
```

This generates:
- `motebit.md` — a signed agent identity file (commit this)
- `~/.motebit/keys/<id>.key` — your Ed25519 private key (never commit this)

## Verify

```bash
npx create-motebit verify
npx create-motebit verify path/to/motebit.md
```

## What is a motebit.md?

A `motebit.md` is a human-readable, cryptographically signed agent identity file. It gives your AI agent:

- **Sovereign identity** — an Ed25519 keypair that proves who the agent is
- **Governance** — trust mode, risk thresholds, operator controls
- **Privacy** — sensitivity levels, retention rules, fail-closed defaults
- **Memory** — decay parameters, confidence thresholds

The identity file is YAML frontmatter signed with Ed25519. Any tool can verify it using the [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) package.

## Options

```
npm create motebit                Create a signed motebit.md
npx create-motebit verify [path]  Verify a motebit.md signature

-o, --output <path>   Output path (default: motebit.md)
-v, --version         Print version
-h, --help            Print help
```

## License

MIT
