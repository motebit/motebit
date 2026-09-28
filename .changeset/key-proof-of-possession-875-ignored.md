---
"@motebit/relay": minor
"@motebit/mcp-server": minor
"@motebit/molecule-runner": patch
"@motebit/spatial": patch
---

The relay's key writers demand proof of possession (#875). This changeset covers the ignored packages; the published `motebit` half is in the sibling changeset.

- `@motebit/relay`:
  - **Bootstrap.** `POST /api/v1/agents/bootstrap` verifies a device-registration signature by the key it names before any write, using `verifyKeyPossession` over `verifyDeviceRegistration`. It refuses an unsigned body with `400 KEY_PROOF_REQUIRED` and a repair instruction.
  - **Register.** A `POST /api/v1/agents/register` body key enters only when there is evidence for it: it is the key the bearer's token verified under, the identity's proven holder key, or the new key of a verified `succession`, or it carries `key_proof`. A key that is only a device row is not evidence, which closes the pairing-laundering path. The master token asserts on the operator's authority.
  - **Pairing approve.** A `key_transfer` is kept only when its `identity_pubkey_check` is the approver's own verified key. `/pairing/claim` still takes an unsigned key; that is a named residual.
  - **Stated cost.** A sovereign identity that rotated away from its genesis key cannot first-register its current key on a relay that has never seen it (`409 SOVEREIGN_ID_KEY_MISMATCH`). It needs migration from a source relay, or registration with its genesis key followed by a rotation.
  - **Sovereign ids.** For an identity holding no key, every registration door refuses a UUIDv8-shaped id that is not exactly `deriveSovereignMotebitId(public_key)` (`409 SOVEREIGN_ID_KEY_MISMATCH`). That closes the pre-registration squat of a sovereign id.
- `@motebit/mcp-server`: `RelayAuth` gains an optional `signRegistration`, and the service signs its bootstrap with it. Without it, the service never sends an unsigned bootstrap: it logs once and registers with its signed bearer.
- `@motebit/molecule-runner`: wires `signRegistration` from the molecule's identity key.
- `@motebit/spatial`: signs its bootstrap with the held private key.
