# @motebit/verify

Standalone verifier for `motebit.md` agent identity files.

Implements the verification algorithm from the [motebit/identity@1.0](https://github.com/hakimlabs/motebit/blob/main/spec/identity-v1.md) specification. Zero monorepo dependencies — only [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) for cryptography.

## Install

```bash
npm install @motebit/verify
```

## Usage

```typescript
import { verify } from "@motebit/verify";
import fs from "node:fs";

const content = fs.readFileSync("motebit.md", "utf-8");
const result = await verify(content);

if (result.valid) {
  console.log("Verified:", result.identity.motebit_id);
  console.log("Owner:", result.identity.owner_id);
  console.log("Trust:", result.identity.governance.trust_mode);
} else {
  console.error("Verification failed:", result.error);
}
```

### Parse without verifying

```typescript
import { parse } from "@motebit/verify";

const { frontmatter, signature, rawFrontmatter } = parse(content);
console.log(frontmatter.motebit_id);
```

## API

### `verify(content: string): Promise<VerifyResult>`

Verify a `motebit.md` file's Ed25519 signature.

Returns `{ valid: true, identity }` on success, or `{ valid: false, identity: null, error }` on failure.

### `parse(content: string): { frontmatter, signature, rawFrontmatter }`

Parse a `motebit.md` file into its components. Does not verify the signature.

Throws if the file is malformed (missing frontmatter delimiters or signature).

## What is a motebit.md?

A `motebit.md` is a human-readable, cryptographically signed agent identity file. It contains YAML frontmatter with identity, governance, privacy, and memory configuration, followed by an Ed25519 signature in an HTML comment.

See the [motebit/identity@1.0 specification](https://github.com/hakimlabs/motebit/blob/main/spec/identity-v1.md) for details.

## License

MIT — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The MIT License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
