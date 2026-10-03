---
"@motebit/crypto": minor
"motebit": patch
---

Pairing binds the relay-supplied `motebit_id` to the transferred identity key, and every identity-verify path reads the succession chain.

Two shared helpers in `@motebit/crypto` (re-exported through `@motebit/encryption` and `@motebit/identity-file` for the surfaces), one each — never five copies:

- `verifyPairingIdentityBinding(motebitId, transferredPublicKeyHex)` — the binding ladder applied at pairing. An id that is the self-certifying commitment to the transferred key is accepted (`sovereign`); a self-certifying id (UUIDv8 or `did:key`) that commits to any OTHER key is refused (`invalid`) — a relay cannot pin a device to an identity the transferred key contradicts; a legacy id that commits to no key is accepted at `unverified`, the rung it already reads at everywhere else.
- `identityVerifyOutcome(result)` — an identity file is intact only when its signature AND its succession chain verify. A file re-signed by a key its chain never legitimately reaches is not intact, however valid its signature.

Device B's `completePairing` on mobile, desktop and web now decrypts the transferred key and checks the binding BEFORE anything is written: a refused id leaves the keyring/config, in-memory identity, private key and the relay's device registration untouched, and the pairing UI shows the refusal. Previously mobile wrote the relay's `motebit_id` before decrypting anything.

`motebit verify <motebit.md>`, `motebit rotate`, `motebit run`/daemon identity load, desktop `verifyIdentityFile`, web/mobile `verifyMotebitMd`, and the shared `importIdentityFile` (restore preview on all three app surfaces) now reject a broken succession chain instead of reporting the identity intact.

Residual, stated rather than hidden: a legacy (non-self-certifying) id commits to no key, so a relay can still name one for any transferred key — that rung stays `unverified`, as it reads everywhere else. And pairing does not carry the succession chain, so a self-certifying identity that has ROTATED its key fails closed at pairing until the chain is transported (`verifyMigratingKeyBinding` already composes the check once it is).
