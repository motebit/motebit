# create-motebit

Create a cryptographically signed agent identity.

## Quick Start

```bash
npm create motebit my-agent
cd my-agent
npm install
node verify.js
```

4 commands from zero to a verified agent identity.

## What it creates

```
my-agent/
  motebit.md       Signed agent identity (Ed25519)
  verify.js        Verification example
  package.json     Node project with @motebit/verify
  .env.example     Environment variable template
  .gitignore       Secrets excluded
```

## Verify

```bash
npx create-motebit verify
npx create-motebit verify path/to/motebit.md
```

## What is a motebit.md?

A `motebit.md` is a human-readable, cryptographically signed agent identity file. It gives your AI agent:

- **Sovereign identity** — an Ed25519 keypair that proves who the agent is, with a W3C `did:key` for interoperability
- **Governance** — trust mode, risk thresholds, operator controls
- **Privacy** — sensitivity levels, retention rules, fail-closed defaults
- **Memory** — decay parameters, confidence thresholds

The identity file is YAML frontmatter signed with Ed25519. Any tool can verify it using the [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) package.

## Options

```
npm create motebit [dir]          Scaffold with identity generation
npm create motebit [dir] --yes    Non-interactive (requires MOTEBIT_PASSPHRASE)
npm create motebit [dir] --service  Create a service identity
npx create-motebit verify [path]  Verify a motebit.md signature

-v, --version         Print version
-h, --help            Print help
```

## License

MIT — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The MIT License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
