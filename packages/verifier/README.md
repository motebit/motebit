# @motebit/verifier

Apache-2.0 library for verifying signed Motebit artifacts. The thin file-reading + human-formatting layer on top of [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto)'s pure verification primitives.

```bash
npm i @motebit/verifier
```

```ts
import { verifyFile } from "@motebit/verifier";

const result = await verifyFile("./receipt.json");
if (result.valid) {
  console.log(`receipt signed by ${result.receipt?.signer}`);
}
```

Zero relay contact. Zero network. The signer's public key is embedded in the artifact or derivable from it; verification is pure crypto against committed wire formats.

## Looking for the `motebit-verify` command-line tool?

Install [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) instead. That package ships the `motebit-verify` binary with every hardware-attestation platform bundled. This package (`@motebit/verifier`) is the library it sits on — reach for it when you're writing TypeScript code that consumes signed artifacts programmatically.

The naming follows the verb / agent-noun lineage that survives for decades — `git` / `libgit2`, `cargo` / `tokio`, `npm` / `@npm/arborist`. Verb (`verify`) = the tool a human installs. Agent-noun with `-er` suffix (`verifier`) = the library code links against.

## Why this exists

Motebit's moat is the **self-signing body**: every action the agent takes emits a signed receipt that any third party can verify without running the motebit. This package is the smallest public surface of that promise — a deterministic verification library that answers _"is this signed artifact authentic, and what does it claim?"_ — exposed for programmatic consumption.

## What it verifies

The unified `verify()` dispatcher in [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) auto-detects and verifies:

- **identity** — `motebit.md` (YAML frontmatter + content + Ed25519 signature)
- **receipt** — `ExecutionReceipt` (task ID, tools used, prompt/result hashes, signature)
- **credential** — W3C-style Verifiable Credentials
- **presentation** — W3C-style Verifiable Presentations

This package wraps the dispatcher with `verifyFile` (path → result), `verifyArtifact` (string → result), and `formatHuman` (result → printable banner).

## Guarantees

- **No network.** Verification runs entirely offline. No relay calls, no DID resolution over the wire.
- **No dependencies beyond `@motebit/crypto`.** Every dependency is a trust attack surface we'd have to re-audit on every upgrade.
- **Suite-agile.** New signature suites (post-quantum, future) are registry additions, not library changes — `@motebit/crypto`'s `verifyBySuite` dispatches for us.

## Related

- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — the **`motebit-verify` CLI** that ships with every hardware-attestation platform bundled. Install this if you want the command-line tool.
- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — the verification primitives this package wraps (Apache-2.0, zero deps)
- [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) — protocol types for the artifacts being verified (Apache-2.0, zero deps)
- [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk) — developer contract for building Motebit-powered agents
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity
- [`motebit`](https://www.npmjs.com/package/motebit) — reference runtime and operator console

## License

Apache-2.0 — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
