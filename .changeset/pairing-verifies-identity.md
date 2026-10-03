---
"@motebit/crypto": minor
"motebit": patch
"create-motebit": patch
---

Pairing binds the relay-supplied `motebit_id` to the transferred identity key (rotated identities included), refuses an approval whose key transfer is missing or does not verify, and every identity-verify path reads the succession chain.

Two shared helpers in `@motebit/crypto` (re-exported through `@motebit/encryption` and `@motebit/identity-file` for the surfaces), one each — never five copies:

- `verifyPairingIdentityBinding(motebitId, transferredPublicKeyHex, { successionChain? })` — the binding ladder applied at pairing:
  - the id is the self-certifying commitment to the transferred key → accepted (`sovereign`);
  - the id is self-certifying (UUIDv8 or `did:key`) and the transferred key is its CURRENT key after rotation → accepted (`sovereign`) only when the supplied succession chain verifies (every link signed by the key it departs, continuous, temporally ordered), its genesis is the key the id commits to, and its terminal key is the transferred key. The chain is consulted only when the direct derivation fails and may be passed as a lazy loader;
  - a self-certifying id no verified lineage connects to the transferred key → refused (`invalid`);
  - a legacy (UUIDv7) id commits to no key → accepted at `unverified`, the rung it reads at everywhere else; the chain is never consulted.
- `identityVerifyOutcome(result)` — an identity file is intact only when its signature AND its succession chain verify.

Device B's `completePairing` on mobile, desktop and web:

- REQUIRES the key transfer. Every in-tree Device B claims with an X25519 key and every Device A answers it with a key transfer, so an approval without one, or one that fails to decrypt / fails its `identity_pubkey_check`, means the relay dropped or tampered with it. Pairing is refused ("Pairing refused: …") with nothing written — keyring/config, in-memory identity, private key and the relay device registration untouched — and the pairing UI shows it. Previously the relay-supplied `motebit_id` was persisted anyway, with the device keeping its own key.
- Checks the binding before anything is written. For a rotated sovereign identity the chain is fetched from the relay's public `GET /api/v1/agents/:motebitId/succession` (new `PairingClient.getSuccessionChain`) and verified on the device: the relay transports it but cannot author it, so a withheld, failed or forged chain only refuses, never accepts. Rotated sovereign identities pair again (the previous revision of this change refused them).

`motebit verify <motebit.md>`, `motebit verify <bundle dir>`, `motebit rotate` (pre-check and post-rotation self-check), `motebit run`/daemon identity load, `create-motebit verify` / `create-motebit rotate` (pre-check and self-check), desktop `verifyIdentityFile`, web/mobile `verifyMotebitMd`, and the shared `importIdentityFile` (restore preview on all three app surfaces) now reject a broken succession chain instead of reporting the identity intact.

Residuals, stated rather than hidden:

- A legacy (non-self-certifying) id commits to no key, so a relay can still name one for any transferred key — that rung stays `unverified`, as it reads everywhere else.
- A rotated identity whose chain contains a guardian-recovery link is refused at pairing: no guardian key is pinned on the pairing device, and accepting a source-supplied one would let that source forge the lineage. Such an identity fails closed at pairing until a guardian key can be pinned on the pairing device.
- A relay that withholds the succession chain can deny pairing to a rotated identity (availability, not integrity): it cannot make the device adopt a wrong id.
