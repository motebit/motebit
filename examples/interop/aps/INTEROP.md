# Interop record: Agent Passport System (APS)

Conformance record for the Motebit ↔ APS exchange (motebit/motebit#22). Each direction names
what is pinned, what is claimed and where the proof runs. Levels refer to the interop ladder
(L0–L6). Provenance and license of the vendored file are in [`NOTICE.md`](NOTICE.md).

The pins in the block below are **read by Motebit's test**. Editing them without the vendored
bytes matching turns CI red, so this record cannot drift from what is verified.

```interop-pins
vector_path: case-a-neutral-vector.CANDIDATE.json
vector_upstream_commit: 2508f6a7
vector_sha256: 4918125741234d749e4ab23cb6ec98c12f6b86b951147eca984b04a76bb53d31
```

## APS → Motebit (APS verifies Motebit artifacts)

- **Level:** L4. External consumer test in the counterparty's repository, run in their CI by
  `npm run test:interop` (APS `main` CI run 37351561578, 2026-10-05, passed).
- **Their test:** [`tests/interop/motebit-receipts.test.ts`](https://github.com/agent-passport-system/agent-passport-system/blob/a8bdf52571c7e72035c8bb3a58e56059376e867f/tests/interop/motebit-receipts.test.ts)
  at agent-passport-system `a8bdf52`.
- **Pins:** Motebit fixtures at `fed97862`, with fixture hashes and expected verdicts
  ([fixtures](https://github.com/agent-passport-system/agent-passport-system/tree/a8bdf52571c7e72035c8bb3a58e56059376e867f/examples/interop/motebit)).
- **Claim ceiling (as agreed on #22):** integrity of the canonical signed bytes under the embedded
  key, the signed `task_id`, and the declared suite. It does not establish who controls the signer
  or whether the task occurred.
- **Status:** documentary on our side. We cannot execute their CI from this repository; their
  pinned commit is the anchor.

## Motebit → APS (Motebit verifies an APS artifact)

- **Level:** L4. On `main` since #1045 (2026-10-04) and run in CI.
- **Our test:** [`scripts/__tests__/interop-aps-vector.test.ts`](../../../scripts/__tests__/interop-aps-vector.test.ts),
  run in CI by `pnpm test:gates`. It imports no APS code: JCS, SHA-256 and Ed25519 come from
  `@motebit/crypto`.
- **Pins:** the block above (APS vector at upstream `2508f6a7`). APS later published `d4f39dc`, which
  only adds a construction reference; the records are unchanged, so the verified bytes stay pinned.
- **Asserted:**
  - the fixture's SHA-256 equals the pin;
  - both `delegation_id`s reproduce and both Ed25519 signatures verify under
    draft-pidlisnyi-aps-04 §4.1 (domain-separated JCS), and tampering a signed field fails;
  - linkage: `parent_delegation_id`, issuer equals parent subject, root issuer is a declared
    trust anchor;
  - narrowing on scope (hierarchical: `net:http:*` covers `net:http:get`), time window (contains
    `evaluated_at`) and depth;
  - ancestor revocation: `ancestor-active` is valid; `ancestor-revoked` is invalid with `REVOKED`
    at index 0.
- **Not evaluated:** spend, reputation, values, reversibility. Motebit's spend ceilings live in its own grant model and are not mapped to APS spend-limit semantics, so spend is not evaluated even where it is unchanged along the chain. Reported `not_evaluated`; the
  evaluator has no path that marks them `pass`. (APS §4.2 orders reversibility
  `tentative < compensable < irreversible`; recorded as the APS profile's rule, not evaluated by
  Motebit.)
- **Claim ceiling:** Motebit independently reproduces and verifies this one CANDIDATE vector's
  cryptography, linkage and scope/time/depth/ancestor-revocation semantics. Not full APS
  compatibility, not conformance to the APS authority-delegation v1 profile, nothing beyond this
  vector. The scope rule is a minimal implementation covering this vector's grants, not the
  complete `aps-hierarchical-v1` profile.

## Status

Bidirectional at the claim ceilings above. Each direction is a second implementation (each side
verifies the other's artifact with its own code), not an independent record: no third party has run
either direction.
