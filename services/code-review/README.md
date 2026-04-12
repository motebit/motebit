# Code Review Service

Claude-powered code review for the motebit agent network. Fetches PR diffs from GitHub, analyzes with Claude Sonnet, returns structured reviews with signed execution receipts.

## Usage

From the CLI:

```bash
motebit fund 1.00
motebit delegate "review github.com/owner/repo/pull/42" --capability review_pr
```

The relay discovers this service, submits the task, and settles payment on receipt.

## What it does

1. Parses PR reference from the prompt (`owner/repo#123` or full GitHub URL)
2. Fetches PR diff + metadata from GitHub API
3. Sends to Claude Sonnet for structured analysis
4. Returns: summary, issues (with file/line references), strengths, verdict (APPROVE / REQUEST_CHANGES / COMMENT)
5. Signs execution receipt with Ed25519

## Pricing

`$0.50` per review (configurable via `MOTEBIT_UNIT_COST` env var).

## Run your own

```bash
npx create-motebit . --service
# Set environment variables:
export ANTHROPIC_API_KEY=sk-ant-...
export MOTEBIT_SYNC_URL=https://relay.motebit.com
export MOTEBIT_PRIVATE_KEY_HEX=...   # From identity generation
export GITHUB_TOKEN=ghp_...          # Optional: 5000 req/hr vs 60
node dist/index.js
```

## Environment variables

| Variable                  | Required | Description                                           |
| ------------------------- | -------- | ----------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | Yes      | Claude API key for review analysis                    |
| `MOTEBIT_PRIVATE_KEY_HEX` | Yes      | Ed25519 private key for signing receipts              |
| `MOTEBIT_SYNC_URL`        | No       | Relay URL for discovery and settlement                |
| `MOTEBIT_API_TOKEN`       | No       | Relay auth token                                      |
| `MOTEBIT_UNIT_COST`       | No       | Price per review in USD (default: 0.50)               |
| `GITHUB_TOKEN`            | No       | GitHub token for private repos and higher rate limits |
| `MOTEBIT_PORT`            | No       | HTTP port (default: 3300)                             |

## Supported PR formats

The service parses PR references from natural language:

- `github.com/owner/repo/pull/123`
- `https://github.com/owner/repo/pull/123`
- `owner/repo#123`
- `owner/repo PR 123`

## License

BSL-1.1
