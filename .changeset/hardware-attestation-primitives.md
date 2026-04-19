---
"@motebit/protocol": minor
"@motebit/wire-schemas": minor
"@motebit/semiring": minor
---

Hardware attestation primitives — three additive extensions that ship the
"rank agents by hardware-custody strength" dimension ahead of demand.

Lands three pieces per the architectural proximity claim:

1. `DeviceCapability.SecureEnclave` — new enum value alongside `PushWake` /
   `StdioMcp` / friends. Declares that a device holds its identity key
   inside hardware (Secure Enclave, TPM, Android StrongBox, Apple
   DeviceCheck) and can produce signatures the private material never
   leaves.

2. `HardwareAttestationClaim` — new wire-format type in
   `@motebit/protocol`, exported as `HardwareAttestationClaimSchema` +
   committed `hardware-attestation-claim-v1.json` from `@motebit/wire-
schemas`. Carried as the optional `hardware_attestation` field on
   `TrustCredentialSubject`. Fields: `platform`
   (`secure_enclave`/`tpm`/`play_integrity`/`device_check`/`software`),
   `key_exported?`, `attestation_receipt?`. The outer `AgentTrustCredential`
   VC envelope's `eddsa-jcs-2022` proof covers the claim; no new
   signature suite needed.

3. `HardwareAttestationSemiring` in `@motebit/semiring` — fifth semiring
   consumer after agent-routing / memory-retrieval / notability /
   trust-propagation / disambiguation. `(max, min, 0, 1)` on `[0, 1]`
   scalars — structurally identical to `BottleneckSemiring` under a
   different interpretation. Parallel routes pick the strongest
   attestation; sequential delegation is as strong as the weakest link.

Fully additive. No existing credential, receipt, or routing call changes.
A consumer that ignores the new optional field observes the exact same
wire format it did before this change. Spec: `spec/credential-v1.md` §3.4
(new subject-field-extension subsection under §3.2 + new §3.4 type
block).

Doctrinal note: shipped ahead of demand on "inevitable-anyway" reasoning
— keeps the adapter boundary clean when a real partner (Apple DeviceCheck
/ Play Integrity / TPM-quote-parsing vendor) lands. Per the metabolic
principle the attestation verification itself is glucose (absorbed via
platform adapters); the ranking algebra + claim interpretation is the
enzyme this change lands.
