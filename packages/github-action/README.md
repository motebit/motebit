# motebit-verify GitHub Action

Verify the Ed25519 signature of a `motebit.md` agent identity file in your CI pipeline. Fails the check if the signature is invalid or the file is missing.

Uses [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) (MIT, zero dependencies) under the hood.

## Quick Start

```yaml
# .github/workflows/verify-identity.yml
name: Verify Agent Identity
on: [push, pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: motebit/motebit/packages/github-action@main
```

## Full Example

```yaml
name: Agent Identity Gate
on:
  pull_request:
    paths: ["motebit.md", "agents/*/motebit.md"]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: motebit/motebit/packages/github-action@main
        id: identity
        with:
          path: motebit.md

      - name: Annotate PR
        if: success()
        run: |
          echo "### Agent Identity Verified" >> $GITHUB_STEP_SUMMARY
          echo "- **motebit_id:** ${{ steps.identity.outputs.motebit-id }}" >> $GITHUB_STEP_SUMMARY
          echo "- **public_key:** ${{ steps.identity.outputs.public-key }}..." >> $GITHUB_STEP_SUMMARY
```

## Inputs

| Input             | Default      | Description                    |
| ----------------- | ------------ | ------------------------------ |
| `path`            | `motebit.md` | Path to the identity file      |
| `fail-on-missing` | `true`       | Fail if the file doesn't exist |
| `node-version`    | `20`         | Node.js version                |

## Outputs

| Output       | Description                          |
| ------------ | ------------------------------------ |
| `valid`      | `true` if signature is valid         |
| `motebit-id` | The `motebit_id` from the file       |
| `public-key` | First 16 hex chars of the public key |

## What it checks

1. The `motebit.md` file exists at the specified path
2. The YAML frontmatter is well-formed per [motebit/identity@1.0](https://github.com/motebit/motebit/blob/main/spec/identity-v1.md)
3. The Ed25519 signature is cryptographically valid over the frontmatter bytes

A valid signature proves the file hasn't been tampered with since it was signed by the agent's private key.

## How it works

The action runs `create-motebit verify <path>`, which:

- Parses YAML frontmatter between `---` delimiters
- Extracts the Ed25519 signature from the `<!-- motebit:sig:... -->` comment
- Verifies the signature against the `identity.public_key` field
- Validates key succession chains if present

No network calls are made. All verification is offline and deterministic.

## Troubleshooting

**"motebit.md not found"** — Check the `path` input. Default is `motebit.md` in the repository root.

**"signature verification failed"** — The file was modified after signing. Re-sign with `npx create-motebit` or `motebit export`.

**Slow first run** — The action downloads `create-motebit` via npx on first use. Subsequent runs in the same job use the npm cache.

## License

MIT
