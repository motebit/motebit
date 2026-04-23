# Protocol model

Motebit is a protocol, not a platform. This has concrete architectural consequences that bend every design decision.

## The three-layer model

Every function the relay performs lives in exactly one of three layers, and each layer has a different shape of ownership:

1. **Protocol** — the open spec anyone can implement. Published in [`spec/`](../../spec/). Consumed via the permissive-floor type packages (Apache-2.0 today: `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, and the platform-attestation leaves `@motebit/verifier`, `@motebit/crypto-appattest`, `@motebit/crypto-play-integrity`, `@motebit/crypto-tpm`, `@motebit/crypto-webauthn`). A third party reading only the specs and the permissive-floor types can build an interoperating alternative without permission. The architectural role is "permissive floor"; the specific license instance (Apache-2.0) is replaceable.
2. **Reference implementation** — Motebit, Inc.'s code that implements the protocol. BSL-1.1: source-available, commercially restricted during the early phase, automatically converting to Apache-2.0 after the conversion date. Same pattern as MariaDB, CockroachDB, Stripe, Confluent, and Ethereum's commercial clients. Both license families converge to Apache-2.0 at the Change Date — one license in the end state.
3. **Accumulated state** — trust history, federation graph, network effects, operational data. Never licensed; private to the canonical relay operator. The long-term moat that makes the reference implementation commercially defensible.

A function is "protocol-shaped" only when its rules live in an open spec. A rule that exists only in BSL implementation code is not yet part of the protocol — it is part of the canonical implementation.

## The permissive / BSL boundary test

For every package, module, or function, ask which question it answers:

**Permissive floor** (Apache-2.0) if it answers: What is the artifact? How is it encoded? How is it signed? How is it verified? What deterministic math defines interoperability? What interface must another implementation satisfy?

**BSL** if it answers: How does the system decide? How does the system adapt over time? How does the system monetize, route, prioritize, govern, or operationalize? How does the product behave in practice?

The permissive floor defines the interoperable protocol: artifacts, cryptography, deterministic algebra, abstract interfaces. BSL contains the stateful runtime, orchestration, governance, memory, routing, and product implementations that make Motebit commercially differentiated. Accumulated state is never licensed — it is the permanent moat.

## The operational test

For any relay function, ask: _can a third party stand up a competing implementation today, using only the published specs and the permissive-floor type packages, without permission?_ If yes, the function has crossed from platform into protocol. If no, it is still platform-shaped regardless of how the codebase is organized internally. This is the honest measure of "how protocol-shaped is motebit right now."

## Sync is the floor of legitimate centralization

Multi-device sync is the only relay function with a legitimate centralization premium — devices are intermittently online and NAT/offline/push notifications are hard to do peer-to-peer. Every other relay function (discovery, trust aggregation, multi-hop orchestration, settlement, federation, sybil defense, credential verification) can exist as a service so long as it is optional, replaceable, and spec-governed. The relay may offer these — and should, because they are how the commercial entity earns — but they must not be the only path.

## Foundation law vs implementation convention

Protocol specs must distinguish what every implementation must preserve (foundation law) from what one particular implementation happens to be elegant at (convention). Foundation law should survive chain change, hardware upgrades, multisig wrappers, and hot/cold key splits without breaking. Conventions are how a specific reference implementation chooses to satisfy the foundation law, not binding on alternative implementations. When writing a spec, if a rule cannot survive swapping the chain or the wallet topology, it does not belong in foundation law — it belongs in the reference implementation section, clearly marked as convention.

## Cryptosuite agility (2026-04-13)

The verification recipe — not the primitive name — is foundation law. Every signed wire-format artifact carries a `suite: SuiteId` field alongside its `signature`; `SuiteId` is a closed string-literal union in `@motebit/protocol/crypto-suite.ts`. The suite bundles algorithm + canonicalization + signature encoding + key encoding into one identifier (matches W3C VC 2.0's `cryptosuite: "eddsa-jcs-2022"` and COSE/JOSE algorithm registries).

Five suites ship today:

| Suite                           | Used by                                       |
| ------------------------------- | --------------------------------------------- |
| `motebit-jcs-ed25519-b64-v1`    | Receipts, delegation, migration, dispute      |
| `motebit-jcs-ed25519-hex-v1`    | Identity, succession, anchors, relay metadata |
| `motebit-jwt-ed25519-v1`        | Signed bearer tokens                          |
| `motebit-concat-ed25519-hex-v1` | Federation handshake + heartbeat              |
| `eddsa-jcs-2022` (W3C)          | VCs/VPs                                       |

Verifiers dispatch primitive verification through `verifyBySuite` in `packages/crypto/src/suite-dispatch.ts` — the one file permitted to call `@noble/ed25519` directly. Missing or unknown suite values are rejected fail-closed. Post-quantum migration (ML-DSA-44, ML-DSA-65, SLH-DSA-SHA2-128s — NIST FIPS 204/205) becomes a new `SuiteId` plus a new dispatch arm, not a wire-format break.

## Protocol-shaped events

### Settlement (2026-04-08)

The first protocol layer where the operational test passes without any relay dependency. Foundation law lives at receipt / verification / sovereign-floor / relay-optional / plural-rails — not at wallet topology. The Ed25519/Solana curve coincidence (where a motebit's identity public key is natively a valid Solana address) is documented as the **default reference implementation**, not protocol law. Multi-hop sovereign settlement is first-class under the foundation law, even though only relay-mediated multi-hop is currently wired in the runtime; pay-forward, onchain escrow, and hybrid are specified as compliant alternatives. Compatible implementations — multisig treasuries, hardware-backed identity, separate identity/wallet keys with binding attestation, different Ed25519-native chains, post-quantum migration — are first-class citizens, not deviations. Sovereign payment receipts anchor to onchain proofs via `task_id = "{rail}:tx:{txHash}"` and are signed by the motebit's identity key — _the wallet transaction is referenced as data, not as the signing authority_. That structural decoupling lets every alternative wallet topology coexist under the same receipt format.

### Credential anchoring (2026-04-10)

Extends the settlement precedent to trust proof. Payment proof was already onchain; now credential proof is too. A third party can verify a credential anchor proof using only `@motebit/crypto` (`verifyCredentialAnchor`) and the relay's public key — no relay contact. Foundation law: leaf hash (SHA-256 of canonical JSON including VC proof), Merkle batch structure (binary tree, odd-leaf promotion), batch signature payload (`{batch_id, merkle_root, leaf_count, first_issued_at, last_issued_at, relay_id}`), 4-step verification algorithm. Convention: Solana Memo program as the reference chain anchor. The chain is additive — credentials are valid without an anchor. The anchor prevents the relay from denying a credential existed.

### Revocation anchoring (2026-04-11)

Key revocation events (`agent_revoked`, `key_rotated`) are anchored onchain immediately via Solana Memo (`motebit:revocation:v1:{revoked_public_key_hex}:{timestamp}`). No batching — revocations are rare and urgent. Any party can verify via memo lookup without contacting a relay. Closes the NIST SP 800-63 revocation gap: no CA, no CRL, no OCSP — the chain is the registry. `verifyRevocationAnchor` in `@motebit/crypto` (permissive floor) does offline verification.

### Discovery, migration, dispute code-complete (2026-04-11)

Discovery (`services/api/src/discovery.ts`): `GET /.well-known/motebit.json` signed relay metadata, `GET /api/v1/discover/:motebitId` with federation propagation, hop limits, loop prevention. Migration (`services/api/src/migration.ts`): MigrationToken, DepartureAttestation, CredentialBundle export, accept-migration with signature verification, cancel/depart lifecycle. Dispute (`services/api/src/disputes.ts`): allocation→disputed transition, evidence, signed operator resolution with refund/release/split, appeal (one per dispute), trust-layer disputes for p2p. CLI: `motebit discover`, `motebit migrate`. Protocol types (Apache-2.0) for all three in `@motebit/protocol`.

## The relay is a convenience layer, not a trust root

The relay provides real-time speed: federation heartbeat for revocations, discovery for agents, routing for tasks. But every truth the relay asserts is independently verifiable onchain without relay contact. Credentials via Merkle batch anchoring (`credential-anchor-v1.md` §5.2). Revocations via individual memo anchoring (`credential-anchor-v1.md` §10). Settlements via payment receipts (`settlement-v1.md` §6). The chain is the permanent record. The relay is the fast path. If the relay disappears, every assertion it made survives on the chain.
