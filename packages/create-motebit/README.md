# create-motebit

Scaffold a motebit agent project.

## Quick Start

```bash
npm create motebit my-agent
cd my-agent
npm install
cp .env.example .env     # add your Anthropic API key
npx motebit              # identity created on first run
```

5 commands from zero to a running agent.

## What it creates

```
my-agent/
  package.json       motebit agent project (depends on motebit CLI)
  .env.example       API key configuration
  .gitignore         secrets and build artifacts
```

Identity is bootstrapped automatically on first `npx motebit`. Run `npx motebit export` to export a signed `motebit.md` for daemon mode.

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
npm create motebit [dir]          Scaffold a new agent project
npx create-motebit verify [path]  Verify a motebit.md signature

-v, --version         Print version
-h, --help            Print help
```

## License

Motebit Community License — see [LICENSE](./LICENSE). Not open source.
