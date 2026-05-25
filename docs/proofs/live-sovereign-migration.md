# Live Sovereign Migration: Agent Identity Across Relays

> **Status — live staging proof (single-operator).** First recorded 2026-05-24.
> This is a real-network, real-deployment proof. It is **not** yet a
> multi-operator or adversarial-operator proof — see [What this does _not_
> prove](#what-this-does-not-prove).

## Core claim

A motebit agent can move from one relay to another while keeping its
cryptographic identity, and become discoverable on the destination — **without
the destination trusting the agent's self-report or a key fetched blind.** The
relay is infrastructure; the identity is the agent's. The agent survives the
relay.

## What ran (the evidence)

On 2026-05-24 a sovereign agent migrated between two independently-deployed
relays over the public internet, driven by the same `performMigration`
(`@motebit/runtime`) code path a real agent uses — not a bespoke test harness.

|                               |                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| Command                       | `MOTEBIT_API_TOKEN=… pnpm migrate-live` (`scripts/migrate-live.ts`)                                       |
| Source relay                  | `https://motebit-sync-stg-b.fly.dev` — `relay-2bcd037f-bdcc-418f-acab-bcf56120bf35`                       |
| Destination relay             | `https://motebit-sync-stg-d.fly.dev` — `relay-3ab5dcb2-bf8d-449a-a16b-d036ddf908b3`                       |
| Agent identity                | sovereign: `motebit_id` = a UUIDv8 derived from `sha256(Ed25519 public key)` (`deriveSovereignMotebitId`) |
| Agent `motebit_id` (this run) | `f6b7cb66-b733-8efe-b8c3-2074b5d751c0`                                                                    |
| Result                        | `Discoverable on DEST: YES`                                                                               |
| Cleanup                       | test agent deregistered from both relays (best-effort; `--skip-cleanup` to retain)                        |

Transport is real: real TLS, a real `GET /.well-known/motebit.json`, a real
federation-pinned trust handshake, real HTTP failure modes.

## The flow

```
sovereign agent (owns its Ed25519 key; relay never holds it)
  → registers on SOURCE
  → SOURCE issues a signed MigrationToken (authorization to leave)
  → SOURCE signs a DepartureAttestation (the agent's tenure: trust + task counts)
  → SOURCE exports the credential bundle; the AGENT signs it (the relay does not)
  → agent presents token + attestation + bundle to DESTINATION
  → DESTINATION verifies, binds the agent's key to its id, onboards
  → agent is discoverable on DESTINATION
```

## Trust model — what is verified, what is _not_ trusted

The destination (`accept-migration`, `services/relay/src/migration.ts`,
spec/migration-v1.md §8.2) runs four offline checks, fail-closed, trusting no
self-report:

1. **Source identity** — the source relay's key is established from a **pinned
   federation peer** (Tier 1; the destination has the source pinned) or, failing
   that, from a fetched-and-verified signed `RelayMetadata` (Tier 2). Never a
   bare well-known fetch.
2. **MigrationToken** — `verifyMigrationToken` against the established source key.
3. **DepartureAttestation** — `verifyDepartureAttestation` against the same key.
4. **Key ↔ id binding** — `verifySovereignBinding`: the `motebit_id` _is_ the
   `sha256` commitment to the agent's key, so a substituted key fails. Then the
   agent-signed bundle is verified against that bound key (`verifyCredentialBundle`).

The failure mode this avoids:

```
agent says "I am X"  →  destination says "ok"      ✗  (not this)
source attests departure · agent proves key possession ·
  destination verifies bundle · destination binds key→id   ✓  (this)
```

## What this proves

| Claim                                                     | Status                                      |
| --------------------------------------------------------- | ------------------------------------------- |
| Relay-to-relay migration over real HTTPS, deployed relays | **Proven**                                  |
| Agent identity survives the migration                     | **Proven (staging)**                        |
| Destination does not trust self-reported identity         | **Proven by the verify chain**              |
| Discovery on the destination after onboarding             | **Proven**                                  |
| A stolen token under a different key is rejected          | **Proven (test + this hardened code path)** |

## What this does _not_ prove

This is the honest perimeter — overclaiming would itself violate the
self-attesting principle (`docs/doctrine/self-attesting-system.md`).

| Claim                                           | Status                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-operator / cross-trust-domain**         | **Not proven.** Both relays run under one operator (one Fly account, `sjc`). This is infrastructure + protocol-path validation, **not** trust-graph validation.                        |
| Adversarial / hostile-operator model            | Partially — adversarial _inputs_ are tested; an adversarial _operator_ is not modeled here                                                                                             |
| Rotated-key binding (succession chain)          | Not exercised — the sovereign-binding tier covers never-rotated keys; the `identity_file` succession tier (§8.2 step 6) is deferred until `performMigration` carries the identity file |
| Reputation continuity at scale                  | Not proven — the attestation carries trust + counts; scale behavior is untested                                                                                                        |
| Economic settlement continuity across migration | Not proven here                                                                                                                                                                        |

The honest one-liner: **"a sovereign agent migrated between two
independently-deployed relays over the real internet"** — not "across clouds" or
"across operators." Those are the next milestone.

## Adversarial coverage (regression-locked)

The trust chain above is not demo-only — it is locked by tests in
`services/relay/src/__tests__/migration.test.ts`: bundle-signature tamper →
reject; stolen token under an attacker's key → reject (and not onboarded);
`motebit_id` mismatch → reject; expired token → reject; replayed token → reject
(§10); unestablishable source identity → reject. Gate **#108**
(`check-signed-artifact-consumed-verified`) structurally locks that the
destination actually _calls_ these verifiers — a verifier that exists but is
never invoked is the require-but-not-verify hole this arc closed.

## Reproduce it

```bash
SOURCE_URL=https://motebit-sync-stg-b.fly.dev \
DEST_URL=https://motebit-sync-stg-d.fly.dev \
MOTEBIT_API_TOKEN=<staging bearer> \
pnpm migrate-live
```

The token is the relay's API bearer (shared across the staging pair); it is
read into the process environment only and never printed. The in-process
equivalent — two relays in one Node process — is `pnpm demo-migration`.

## The path to a full (multi-operator) proof

1. A relay run by an **independent operator** as the destination.
2. An **independent verifier** confirming the agent's identity + receipt history
   remain verifiable post-migration.
3. The **rotated-key** tier: `performMigration` carries the `identity_file`; the
   destination validates the succession chain (§8.2 step 6).
4. **Settlement / trust continuity** surviving the move.

## References

- `scripts/migrate-live.ts` — the live harness; `scripts/demo-migration.ts` — the in-process twin
- `services/relay/src/migration.ts` — relay-side `accept-migration`
- `spec/migration-v1.md` — the protocol
- `docs/doctrine/self-attesting-system.md` — evidence over doctrine; the verifier-is-called invariant (#108)
