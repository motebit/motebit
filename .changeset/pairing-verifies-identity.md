---
"@motebit/crypto": minor
"@motebit/protocol": minor
"motebit": patch
"create-motebit": patch
---

Pairing binds the relay-supplied `motebit_id` to the transferred identity key — rotated identities included, whether or not the relay ever saw the rotation — refuses an approval whose key transfer is missing or does not verify, refuses non-canonical ids, and every identity-verify path reads the succession chain.

`@motebit/crypto`:

- `verifyPairingIdentityBinding(motebitId, transferredPublicKeyHex, { successionSources?, guardianKey? })` — the binding ladder applied at pairing, offline, with no operator trust:
  - `motebitId` must be a canonical spelling: a lowercase UUIDv7 or UUIDv8, or a `did:key`. Anything else (case-folded, braced, `urn:uuid:`-prefixed, hyphenless, padded, empty, a UUIDv4 or free text) is refused (`malformed_id`), never normalized;
  - the id is the self-certifying commitment to the key → accepted (`sovereign`);
  - a UUIDv8 / `did:key` whose CURRENT key (after rotation) is the transferred key → accepted (`sovereign`) only when the succession records connect them: every link verified, the chain continuous and strictly ordered in time, rooted at the key the id commits to, ending at the transferred key. `successionSources` are tried in order (records, or lazy loaders), each later one only when the records so far do not bind; records are self-verifying, so no source is trusted — a withheld, failed or forged chain only refuses;
  - a lineage that runs through a guardian-recovery link with no `guardianKey` pinned on the device → refused with `guardian_recovery_unverifiable` and a sentence saying why and what to do;
  - a legacy UUIDv7 commits to no key → accepted at `unverified`.
- New exported types `PairingIdentityRefusalCode`, `PairingSuccessionSource`; `PairingIdentityBindingResult` gains `code`.
- `identityVerifyOutcome(result)` — an identity file is intact only when its signature AND its succession chain verify.

`@motebit/protocol`: `KeyTransferPayload` gains three optional fields, present together or not at all — `encrypted_succession`, `succession_nonce`, `succession_tag`: Device A's own key-succession records, AES-256-GCM-sealed under the same derived transfer key as the seed. Additive and backward-compatible: a payload without them is the earlier shape; an earlier Device B ignores them; the relay stores the transfer opaquely and passes them through.

Pairing on mobile, desktop and web:

- Device A seals its own succession records into the key transfer (the bound identity file's chain and the roster replica's verified links). A sovereign identity rotated while no relay was configured — the relay's `/succession` is `[]` because nothing uploaded the rotation — now pairs; the previous revision of this change could never pair it.
- Device B runs one shared acceptance path (`openPairingKeyTransfer` in the private `@motebit/encryption`): the transfer is REQUIRED (none, undecryptable, or a seed that does not re-derive its `identity_pubkey_check` → refused), then the binding above — the transferred chain first, the relay's public `GET /api/v1/agents/:motebitId/succession` only as the fallback. Refused ⇒ `Pairing refused: …` with nothing written (keyring/config, in-memory identity, private key and the relay device registration untouched), shown by the pairing UI.
- The machine roster's identity-file rule (`boundIdentityFile`) now requires an intact file — signature AND succession chain — before a file contributes records or a guardian.

`motebit verify <motebit.md>`, `motebit verify <bundle dir>`, `motebit rotate` (pre-check and post-rotation self-check), `motebit run`/daemon identity load, `create-motebit verify` / `create-motebit rotate` (pre-check and self-check), desktop `verifyIdentityFile`, web/mobile `verifyMotebitMd`, and the shared `importIdentityFile` (restore preview on all three app surfaces) reject a broken succession chain instead of reporting the identity intact.

Residuals, stated rather than hidden:

- A legacy UUIDv7 commits to no key, so a relay can still name one for any transferred key (the key transfer is not authenticated against the relay, which knows the pairing code) — that rung stays `unverified`, as it reads everywhere else.
- A guardian-recovered identity is refused at pairing by design: no guardian key is pinned on the pairing device, and one carried by the pairing could be the relay's, which would let it forge the lineage. The error says so and points to restoring from the identity's motebit.md with its current recovery seed. Seed-only restore does not recover a rotated identity's id.
- An older Device A sends no chain; then a relay that withholds the chain can deny pairing to a rotated identity (availability, not integrity): it cannot make the device adopt a wrong id.
- A Device A whose key was later rotated away elsewhere still pairs: its own verified chain roots the key it holds, and the relay is not consulted once the transfer binds. The roster reports a superseded key; pairing does not.
