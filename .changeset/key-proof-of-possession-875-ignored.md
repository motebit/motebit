---
"@motebit/relay": minor
"@motebit/mcp-server": minor
"@motebit/molecule-runner": patch
"@motebit/spatial": patch
---

The relay's key writers demand proof of possession (#875). This changeset covers the ignored packages; the published `motebit` half is in the sibling changeset.

- `@motebit/relay`:
  - **Bootstrap.** `POST /api/v1/agents/bootstrap` verifies a device-registration signature by the key it names before any write, using `verifyKeyPossession` over `verifyDeviceRegistration`. It refuses an unsigned body with `400 KEY_PROOF_REQUIRED` and a repair instruction.
  - **Register.** A `POST /api/v1/agents/register` body key enters only when there is evidence for it: it is the bearer's verified device key, a key the identity already holds, or the new key of a verified `succession`, or it carries `key_proof`. The master token asserts on the operator's authority.
  - **Sovereign ids.** For an identity holding no key, every registration door refuses a UUIDv8-shaped id that is not exactly `deriveSovereignMotebitId(public_key)` (`409 SOVEREIGN_ID_KEY_MISMATCH`). That closes the pre-registration squat of a sovereign id.
- `@motebit/mcp-server`: `RelayAuth` gains an optional `signRegistration`, and the service signs its bootstrap with it. Without it, the service never sends an unsigned bootstrap: it logs once and registers with its signed bearer.
- `@motebit/molecule-runner`: wires `signRegistration` from the molecule's identity key.
- `@motebit/spatial`: signs its bootstrap with the held private key.
