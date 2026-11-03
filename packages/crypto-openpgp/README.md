# @motebit/crypto-openpgp

Offline Apache-2.0 verifier for the one OpenPGP signature shape a git hosting operator puts on the commits it creates: a commit's `gpgsig` header holding one v4 RSA/SHA-256 signature, checked against signing keys you pin.

```bash
npm i @motebit/crypto-openpgp
```

Requirements: ESM-only; Node ≥ 20. No dependencies beyond Node built-ins.

`@motebit/verify` uses it to accept the committer time of a landed governed repo change (`spec/repo-change-v1.md` §9) only when the squash commit's signature verifies under the hosting operator's pinned keys (for GitHub, the keys published at `https://github.com/web-flow.gpg`).

## Usage

```ts
import { readFileSync } from "node:fs";
import { parsePinnedSigningKeys, verifyCommitSignature } from "@motebit/crypto-openpgp";

const pinned = parsePinnedSigningKeys(readFileSync("github-signing-keys.asc", "utf8"));
// `raw` is the commit object's bytes (no `commit <size>\0` header).
const check = verifyCommitSignature(raw, "sha1", pinned);
if (check.ok) console.log(check.fingerprint, check.createdAt);
else console.error(check.reason);
```

## What it verifies

1. **The pinned keys.** One or more ASCII-armored `PGP PUBLIC KEY BLOCK`s. Every primary key must be v4 RSA; its fingerprint is computed (RFC 4880 §12.2), never taken from a label. User ID, signature, trust and subkey packets are skipped; subkeys are never candidates. Any other packet, or the same key pinned twice, is refused.
2. **The signature header.** `gpgsig` (`gpgsig-sha256` in a sha256 repository) present exactly once, holding one armored `PGP SIGNATURE` with a correct CRC-24, whose body is one v4 signature packet and nothing after it. One empty continuation line after the END line, as GitHub writes it, is read as the armor's trailing newline.
3. **The signature packet.** Type 0x00 (binary document), RSA, SHA-256; a creation time exactly once in the hashed area; the issuer named by fingerprint and/or key id, which must agree with each other and with the pinned key; no critical subpacket except the creation time; no signature expiration.
4. **The signature.** Not made before its key was created. Over the commit with the signature header removed (git's payload rule) plus the v4 trailer: the digest's left 16 bits must match, then RSA PKCS#1 v1.5 must verify (`node:crypto`). The signature MPI may declare the modulus's full width with leading zero bits (GitHub's form); a key's MPIs must be exact.

`verifyCommitSignature` returns refusals as `{ ok: false, reason }`, never thrown. `parsePinnedSigningKeys` throws, because a bad pin file is a configuration error, not a verdict.

## What a passing verification proves — and what it does not

- **Proves** the holder of a pinned key signed this exact commit object. The creation time it returns is the signer's own statement, signed with the rest, and never before the key's creation time; how far to trust it is the caller's decision.
- **Proves** it offline: every check is deterministic from the pinned key bytes and the commit bytes.
- **Does not prove** the key is unrevoked. The pinned file is the trust decision. Self-signatures and revocation signatures inside it are not evaluated.
- **Does not** accept any other OpenPGP shape (DSA, ECDSA, EdDSA, v3/v5/v6 packets, other hash algorithms). A shape a hosting operator does not use is refused.

## Why pinned

A verifier that fetched the operator's keys at verification time would trust the network on every check. The pinned file is the contract: a third party audits the keys it holds and knows exactly which signer this library accepts. A key rotation is a new block added to the file.
