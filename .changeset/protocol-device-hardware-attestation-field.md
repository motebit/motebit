---
"@motebit/protocol": minor
---

Add optional `hardware_attestation_credential` field to `DeviceRegistration`.

## Why

Phase 1 of the hardware-attestation peer flow needs an identity-metadata channel for a worker's self-issued `AgentTrustCredential` (carrying a `hardware_attestation` claim) to be discoverable by peer verifiers. The cascade-mint primitives have shipped on all five surfaces since 2026-04-19, but the credentials they produce have been inert because `/credentials/submit` rejects self-issued credentials by spec §23.

The peer-flow architecture (per `lesson_hardware_attestation_self_issued_dead_drop.md`) is: subject mints + holds; peers verify + issue. For peers to verify, they need a discovery channel for the subject's self-issued claim. The `/credentials/submit` carve-out approach was rejected on review (it reintroduces the wire shape commit `63fa2199` unwound). The right home is identity metadata: the device record carries the credential; the existing `GET /agent/:motebitId/capabilities` endpoint exposes it.

## What shipped

- `DeviceRegistration` interface gains `hardware_attestation_credential?: string`. JSON-serialized signed VC. Optional — NULL/omitted preserves the existing wire format and storage shape.
- The persistence layer (`@motebit/persistence`) adds a `hardware_attestation_credential TEXT` column to the `devices` table via migration #33. Backwards compatible — existing rows have NULL, behave as before.
- The `/credentials/submit` self-issued rejection (`spec/credential-v1.md` §23, §9.1.5) is **unchanged**. The new field lives on the device record, not the credential index.

Additive optional field; consumers that don't read the field are unaffected. The change is `minor` per semver.
