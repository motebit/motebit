# @motebit/crypto

Verify any Motebit artifact — identity files, execution receipts, verifiable credentials, and verifiable presentations.

One function. Any artifact. Zero runtime dependencies. MIT licensed.

## Install

```bash
npm install @motebit/crypto
```

## Usage

```typescript
import { verify } from "@motebit/crypto";

// Identity file
const r1 = await verify(fs.readFileSync("motebit.md", "utf-8"));
if (r1.type === "identity" && r1.valid) {
  console.log(r1.did); // did:key:z...
  console.log(r1.identity); // full identity file contents
  console.log(r1.succession); // key rotation chain (if present)
}

// Execution receipt (object or JSON string)
const r2 = await verify(receipt);
if (r2.type === "receipt" && r2.valid) {
  console.log(r2.signer); // did:key of the signing agent
  console.log(r2.delegations); // nested delegation verification results
}

// Verifiable credential
const r3 = await verify(credential);
if (r3.type === "credential" && r3.valid) {
  console.log(r3.issuer); // did:key of the issuer
  console.log(r3.subject); // did:key of the subject
  console.log(r3.expired); // false
}

// Verifiable presentation
const r4 = await verify(presentation);
if (r4.type === "presentation" && r4.valid) {
  console.log(r4.holder); // did:key of the holder
  console.log(r4.credentials); // each credential verified independently
}
```

### Strict mode

Pass `expectedType` to fail fast if the artifact doesn't match:

```typescript
const result = await verify(artifact, { expectedType: "receipt" });
// result.valid is false if artifact is not a receipt
```

### Parse without verifying

```typescript
import { parse } from "@motebit/crypto";

const { frontmatter, signature, rawFrontmatter } = parse(identityFileContent);
console.log(frontmatter.motebit_id);
```

## API

### `verify(artifact, options?): Promise<VerifyResult>`

Verify any Motebit artifact. Detects the type automatically from the input.

- **Strings** containing `---` are parsed as identity files
- **Strings** containing JSON are parsed and detected by shape
- **Objects** are detected by shape: receipts have `task_id` + `signature`, credentials have `credentialSubject` + `proof`, presentations have `holder` + `verifiableCredential` + `proof`

Returns a discriminated union — narrow on `result.type` to access type-specific fields.

### `verifyIdentityFile(content): Promise<LegacyVerifyResult>` _(deprecated)_

Verify a `motebit.md` identity file. Returns the legacy result shape with `.identity`, `.did`, `.error` fields directly (no type narrowing needed). Use `verify(content)` instead — it handles all artifact types and returns a richer result.

### `parse(content): { frontmatter, signature, rawFrontmatter }`

Parse a `motebit.md` file into its components. Does not verify the signature. Throws if malformed.

## What can it verify?

| Artifact                | Input                                         | What it checks                                                                         |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Identity file           | String (YAML frontmatter + Ed25519 signature) | Signature over frontmatter, succession chain linkage + temporal ordering               |
| Execution receipt       | Object or JSON                                | Ed25519 signature over canonical JSON, embedded public key, recursive delegation chain |
| Verifiable credential   | Object or JSON                                | eddsa-jcs-2022 Data Integrity proof, expiry, issuer DID extraction                     |
| Verifiable presentation | Object or JSON                                | Envelope proof + each contained credential independently                               |

All verification is **offline** — no network calls, no relay lookup, no runtime dependency. Receipts embed the signer's public key. Credentials embed the issuer's DID. Everything needed for verification is in the artifact itself.

## License

MIT — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The MIT License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
