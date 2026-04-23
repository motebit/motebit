# @motebit/verifier

Offline third-party verifier for every signed Motebit artifact.

```bash
npm i -g @motebit/verifier
motebit-verify motebit.md
```

Outputs

```
VALID (identity)
  did:  did:motebit:01234567-...
  name: my-agent
```

Zero relay contact. Zero network. The signer's public key is embedded in the artifact or derivable from it; verification is pure crypto against committed wire formats.

## Why this exists

Motebit's moat is the **self-signing body**: every action the agent takes emits a signed receipt that any third party can verify without running the motebit. This package is the smallest public surface of that promise — a CLI and a library that together answer _"is this signed artifact authentic, and what does it claim?"_

## What it verifies

The unified `verify()` dispatcher in [`@motebit/crypto`](../crypto) auto-detects and verifies:

- **identity** — `motebit.md` (YAML frontmatter + content + Ed25519 signature)
- **receipt** — `ExecutionReceipt` (task ID, tools used, prompt/result hashes, signature)
- **credential** — W3C-style Verifiable Credentials
- **presentation** — W3C-style Verifiable Presentations

## Usage

```
motebit-verify <file> [options]

  --json                    Print structured JSON instead of human.
  --expect <type>           Pin expected type: identity | receipt | credential | presentation.
  --clock-skew <seconds>    Allowance for credential/presentation time bounds.
  -h, --help
  -V, --version
```

### Exit codes

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| `0`  | Artifact verified                                   |
| `1`  | Artifact invalid (bad signature, expired, mismatch) |
| `2`  | Usage or I/O error                                  |

POSIX-friendly — chain into CI gates, `make` targets, `git` hooks.

### Library

```ts
import { verifyFile } from "@motebit/verifier";

const result = await verifyFile("./receipt.json");
if (result.valid) console.log(`receipt signed by ${result.receipt?.signer}`);
```

## Guarantees

- **No network.** Verification runs entirely offline. No relay calls, no DID resolution over the wire.
- **No dependencies beyond `@motebit/crypto`.** Every dependency is a trust attack surface we'd have to re-audit on every upgrade.
- **Suite-agile.** New signature suites (post-quantum, future) are registry additions, not CLI changes — `@motebit/crypto`'s `verifyBySuite` dispatches for us.

## License

MIT.
