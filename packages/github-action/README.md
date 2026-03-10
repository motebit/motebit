# motebit-verify GitHub Action

Verify the Ed25519 signature of a `motebit.md` agent identity file in your CI pipeline. Fails the check if the signature is invalid or the file is missing.

## Usage

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

### With options

```yaml
- uses: motebit/motebit/packages/github-action@main
  with:
    path: "agents/my-agent/motebit.md"
    fail-on-missing: "false"
```

### Using outputs

```yaml
- uses: motebit/motebit/packages/github-action@main
  id: identity
- run: echo "Agent ${{ steps.identity.outputs.motebit-id }} verified"
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
2. The YAML frontmatter is well-formed per [motebit/identity@1.0](../../spec/identity-v1.md)
3. The Ed25519 signature is cryptographically valid over the frontmatter bytes

A valid signature proves the file hasn't been tampered with since it was signed.

## License

MIT
