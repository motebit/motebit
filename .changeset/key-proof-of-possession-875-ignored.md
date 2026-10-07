---
"@motebit/relay": minor
---

The relay's key writers demand proof of possession (#875) — the relay half. The client half (every CLI, mcp-server, molecule-runner and spatial caller signs its bootstrap) shipped first in #1088 (motebit@2.1.0). An unsigned bootstrap from an older client, such as the published motebit@2.0.1, is now refused with `400 KEY_PROOF_REQUIRED`; the CLI's compat test pins that flip.

- `@motebit/relay`:
  - **Bootstrap.** `POST /api/v1/agents/bootstrap` verifies a device-registration signature by the key it names before any write, using `verifyKeyPossession` over `verifyDeviceRegistration`. It refuses an unsigned body with `400 KEY_PROOF_REQUIRED` and a repair instruction.
  - **Register.** A `POST /api/v1/agents/register` body key enters only when there is evidence for it: it is the key the bearer's token verified under, the identity's proven holder key, or the new key of a verified `succession`, or it carries `key_proof`. A key that is only a device row is not evidence, which closes the pairing-laundering path. The master token asserts on the operator's authority.
  - **A device row is never evidence of the identity's key.**
    - A keyless registration never introduces a key. It writes the holder, else the registry key on file (unchanged), else `""`. It no longer writes main's first-listed device row, nor the caller's own key. The exception is keyless E-sov, whose proven key becomes the holder.
    - Every served identity key (discover by id, the discover list, the federation discover response, `GET /api/v1/agents/:id`, capabilities, the A2A card, and a relay-issued credential's subject) comes from `servedIdentityKey`. The order is:
      1. the proven holder;
      2. else the registry key while it equals the key a request PROVED, recorded as provenance in the new `relay_registry_key_evidence` table (migration v58) and never recorded as the holder;
      3. else, for a never-rotated identity only, a key on file that the id is the sovereign commitment to;
      4. else `""`.

      A registry key without provenance, such as a pre-#875 row, is not served. A rotated identity is never served its stale genesis key.

    - revoke-credential's issuer check reads only the caller's verified key or its holder. A sibling device's key does not qualify, by design.
    - Every device-row read site is classified in a structural test.
  - **Pairing approve.** A `key_transfer` is kept only when its `identity_pubkey_check` is the approver's own verified key. `/pairing/claim` still takes an unsigned key; that is a named residual.
  - **Stated cost.** A sovereign identity that rotated away from its genesis key cannot first-register its current key on a relay that has never seen it (`409 SOVEREIGN_ID_KEY_MISMATCH`). It needs migration from a source relay, or registration with its genesis key followed by a rotation.
  - **Sovereign ids.** For an identity holding no key, every registration door refuses a UUIDv8-shaped id that is not exactly `deriveSovereignMotebitId(public_key)` (`409 SOVEREIGN_ID_KEY_MISMATCH`). That closes the pre-registration squat of a sovereign id.
  - **A pre-#875 squat of a sovereign id is never upgraded to proven.** For a sovereign-shaped id only keys that stand count as the identity's: the genesis key the id commits to, a key reached from it by a recorded succession, or a verified migration's key. A squat key is never served, never re-proven by the squatter's own bearer, and never blocks the owner, whose signed bootstrap or register-self parks it (device rows removed, registry key cleared and delisted, logged).
  - **An accepted proof of possession is accepted once.** The relay records each accepted bootstrap, register-self and `key_proof` body (migration v59, 11-minute retention); an exact replay writes nothing. Cross-relay replay within the 5-minute window is a stated limitation until a future version adds an audience.
