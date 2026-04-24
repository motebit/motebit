# @motebit/api

## 0.2.0

### Minor Changes

- 8cef783: Per-agent settlement anchoring becomes a first-class protocol artifact.

  The `/api/v1/settlements/:id/anchor-proof` and `/api/v1/settlement-anchors/:batchId`
  endpoints shipped on 2026-04-18 returned ad-hoc shapes with no spec, no
  JSON Schema, and no protocol type. This pass closes the full doctrinal
  stack so the worker-audit pyramid (signed `SettlementRecord` floor +
  Merkle inclusion proof + onchain anchor ceiling) is externally legible
  without bundling motebit:
  - **Spec:** `spec/agent-settlement-anchor-v1.md` — parallel artifact to
    `credential-anchor-v1.md`. Defines leaf hash (whole signed
    `SettlementRecord` including signature), batch wire format,
    proof wire format, verification algorithm, and §9 distinguishing
    per-agent from federation (relay-federation-v1.md §7.6) and
    credential anchoring. Cross-references §7.6 for the shared Merkle
    algorithm — same precedent credential-anchor uses.
  - **Protocol types** (`@motebit/protocol`): `AgentSettlementAnchorBatch`,
    `AgentSettlementAnchorProof`, `AgentSettlementChainAnchor`. Same
    shape grammar as the credential-anchor pair so verifiers built for
    one work for the other with a field-name swap.
  - **Wire schemas** (`@motebit/wire-schemas`): published
    `agent-settlement-anchor-batch-v1.json` and
    `agent-settlement-anchor-proof-v1.json` JSON Schemas at stable `$id`
    URLs. A non-motebit Python/Go/Rust verifier consumes them at the
    URL and validates without any monorepo dependency. Drift gate #22
    pins them; gates #9 and #23 ensure spec ↔ TS ↔ JSON Schema parity.
  - **Endpoint shape aligned to spec.** The 2026-04-18 endpoints used
    `{leaf_hash, proof, ...}` (older federation-style vocabulary).
    Per-agent now matches the credential-anchor convention:
    `{settlement_hash, siblings, layer_sizes, relay_id,
relay_public_key, suite, batch_signature, anchor: {...} | null}`.
    Hours-old code, zero external consumers, alignment matters more
    than churn.
  - **Architecture page** lists the new spec (`check-docs-tree` enforces).
  - **Test setup** for per-agent anchoring uses the test relay's actual
    identity from `relay_identity` instead of synthesizing a fresh
    keypair — the proof-serve path looks up the relay's public key from
    that table, so this tests the production wiring end-to-end.
  - **Cosmetic regen** of 14 previously-committed JSON Schemas to match
    the canonical `build-schemas` output (compact arrays expanded to
    one-element-per-line). Drift test was tolerant of the difference
    but the next `build-schemas` run would have surfaced them anyway.

- 84e9729: Per-agent settlement Merkle anchoring — the "ceiling" parallel to
  the federation case. Closes the self-attesting trust pyramid for
  per-agent settlements: signed `SettlementRecord` (floor) + Merkle
  inclusion proof (middle) + onchain anchor reference (ceiling).

  What ships:
  - **Batching loop**: `cutAgentSettlementBatch` collects signed,
    unanchored rows from `relay_settlements`; `submitAgentAnchorOnChain`
    publishes the root via the same `OnChainAnchorSubmitter` abstraction
    as the federation path. Loop wires under `agentAnchorInterval` in
    `createSyncRelay`. New table `relay_agent_anchor_batches` keeps
    the per-agent ledger separate from the federation ledger — distinct
    audiences, identical primitives.
  - **HTTP endpoints** (public, rate-limited):
    - `GET /api/v1/settlements/:settlementId/anchor-proof` — returns
      `202 {status: "pending"}` with `Retry-After: 60` for signed-but-
      unbatched settlements; `200` with leaf hash + Merkle path + batch
      metadata once anchored; `404` for unknown.
    - `GET /api/v1/settlement-anchors/:batchId` — returns the signed
      batch metadata (root, leaf count, optional chain reference).

  Doctrinal sibling-fix: the catch-all `/api/v1/*` bearer-auth
  middleware was gating all four anchor-proof endpoints (credential
  - settlement). That contradicts services/api CLAUDE.md rule 6 —
    "every truth the relay asserts is independently verifiable onchain
    without relay contact." An external auditor doesn't hold a relay
    bearer token. Both endpoint pairs are now allowlisted as public,
    rate-limited at the same `publicLimiter` tier as `/credentials/verify`.

  External verifier flow now mechanical: fetch SettlementRecord +
  proof + chain tx → verify Ed25519 signature → reconstruct leaf →
  walk Merkle path → compare root to chain. No relay contact needed
  beyond the initial proof fetch.

- 8997521: Per-agent settlement Merkle anchoring — the "ceiling" alongside
  the signing "floor" (audit follow-up #1 part C). Brings per-agent
  settlements to feature parity with federation settlements
  (relay-federation-v1.md §7.6, already shipped).

  ## What this delivers

  A worker can now verify they were paid the right amount **without
  contacting the relay** — by holding their signed SettlementRecord,
  the inclusion proof, and the chain transaction reference. Three
  levels of self-attestation now stack:
  1. **Signature** (v13): commits the relay to its claimed amounts.
     "Trust the relay's word" → "trust the relay's commitment."
  2. **Anchor** (this commit): commits the relay to its claimed
     history. Even an issuer-key compromise cannot retroactively
     rewrite anchored records — the chain transaction is immutable.
  3. **External chain verifier** (consumer-side): independent
     confirmation of the Merkle root onchain.

  `services/api/CLAUDE.md` rule 6 — "Every truth the relay asserts
  is independently verifiable onchain without relay contact" — is
  now mechanically delivered for per-agent settlements at parity
  with federation.

  ## What's in this commit
  - **Migration v14** (`agent_settlement_anchor_batches`): - Creates `relay_agent_anchor_batches` table (mirrors
    `relay_anchor_batches` for federation; separate table because
    audiences differ — federation = peer audit, agent = worker audit). - Adds `anchor_batch_id` column to `relay_settlements` (nullable;
    set when batched). - Index on `(settled_at, settlement_id) WHERE anchor_batch_id IS
NULL AND signature IS NOT NULL` — selection is constant-time per
    batch cut.
  - **`anchoring.ts`**:
    - `cutAgentSettlementBatch(db, relayIdentity, maxSize?)` — selects
      unanchored signed settlements, computes leaves via
      `SHA-256(canonicalJson(signed_record))`, builds Merkle tree,
      signs the anchor record, persists batch + assigns `batch_id` to
      each row. Mirrors `cutBatch` (federation).
    - `submitAgentAnchorOnChain(db, batchId, submitter)` — submits
      Merkle root onchain via existing `ChainAnchorSubmitter`.
      Idempotent: only acts on `status = 'signed'` batches.
    - `getAgentSettlementProof(db, settlementId)` — returns inclusion
      proof + anchor record for a settlement. Sufficient for an
      external verifier to recompute the leaf from their held
      SettlementRecord, walk the Merkle path, and compare against
      the onchain root.
  - **Legacy-row safety**: only signed settlements are batched.
    Pre-v13 unsigned rows skip selection (`signature IS NOT NULL`
    filter) — they cannot be anchored because the leaf would not
    match what the relay signed (it didn't).

  8 new tests (cutAgentSettlementBatch + getAgentSettlementProof
  covering happy path, batch_id assignment, legacy-row filter,
  maxSize, proof reconstruction, missing-batch). 870 relay tests
  total (was 862).

  ## Architectural symmetry

  | Audience        | Table                        | Cut function              | Proof function            |
  | --------------- | ---------------------------- | ------------------------- | ------------------------- |
  | Federation peer | `relay_anchor_batches`       | `cutBatch`                | `getSettlementProof`      |
  | Agent (worker)  | `relay_agent_anchor_batches` | `cutAgentSettlementBatch` | `getAgentSettlementProof` |

  Same `ChainAnchorSubmitter` adapter (Solana Memo by default; EVM
  contract via legacy submitter). Same Merkle primitives
  (`buildMerkleTree`, `getMerkleProof` from `@motebit/encryption`).
  Different leaf computations, different aggregation, but the trust
  shape is identical.

  ## Out of scope (future work)
  - Wire-format `AgentSettlementAnchorProof` schema in
    `@motebit/wire-schemas` (would parallel `CredentialAnchorProof`).
  - HTTP endpoint to fetch a proof for an agent settlement.
  - CLI subcommand `motebit verify agent-settlement-proof <path>`
    to run end-to-end verification offline.
  - Periodic batching loop hook for per-agent settlements (today
    callable manually; production deployment can wire it into
    `startBatchAnchorLoop` parallel).

- fe975cd: Endgame marketplace: decouple discoverability from runtime availability. Service agents stay discoverable while asleep — a motebit's identity, listing, and reputation are durable signed artifacts that don't need a running Fly.io machine to exist.

  The relay's `agent_registry.expires_at` becomes a 90-day janitor lease (was 15 minutes). Every read path (`/api/v1/agents/discover`, `/api/v1/agents/:id`, `/federation/v1/task/forward`, `queryLocalAgents`, `buildCandidateProfiles`) drops the `WHERE expires_at > now` visibility filter. `revoked = 0` remains the correct "don't show this agent" filter.

  Discovery response gains a `freshness` field — a computed render hint driven by `last_heartbeat` age, with four bands: `awake` (< 6 min), `recently_seen` (< 30 min), `dormant` (< 24 h), `cold` (≥ 24 h). Additive to the response shape, backward compatible.

  `forwardTaskViaMcp` gets a wake-on-delegation hook: a 5-second GET to the agent's `/health` before MCP init, triggering Fly's auto-start for machines suspended under `auto_stop_machines = "stop"`. Fail-open — MCP init's 30-second timeout still absorbs residual cold-start latency.

  Routing behavior: `buildCandidateProfiles` now computes `is_online` from freshness (awake or recently_seen), not `expires_at`. Dormant and cold candidates remain rankable, not excluded — wake-on-delegation makes them reachable.

  Closes the visibility deadlock that caused motebit.com's Discover panel to show "No agents on the network yet" despite 5 deployed service agents (sleeping services invisible → no delegation → no wake → still invisible).

  Client apps (web, desktop, mobile) render a 6px freshness dot next to the existing "seen X ago" text, matching the calm-software `goal-status-dot` palette. No spatial changes — marketplace scene is tracked separately.

- 1848d2e: Validate inbound wire-format bodies against `@motebit/wire-schemas` at
  the relay boundary. Hand-rolled `as Type` casts are no longer the
  first line of defense — schemas parse bodies (or reject 400) before
  any handler touches them, fail-closed.

  Handlers wired:
  - `POST /agent/:motebitId/verify-receipt` — body is `ExecutionReceipt`
  - `POST /agent/:motebitId/task/:taskId/result` — body is
    `ExecutionReceipt`; replaces the structural `typeof`/status
    allowlist
  - `POST /federation/v1/task/result` — nested `body.receipt` is
    `ExecutionReceipt`
  - `POST /api/v1/agents/accept-migration` — nested `migration_token`,
    `departure_attestation`, `credential_bundle` validated against
    `MigrationTokenSchema`, `DepartureAttestationSchema`,
    `CredentialBundleSchema` respectively

  The package was already a Layer-1 BSL primitive pinned to
  `@motebit/protocol` types by drift defenses #22 and #23; the relay
  was the last unconsumed boundary. Non-motebit implementers (Python,
  Go, Rust workers) have been able to hit the published JSON Schemas
  for months — the runtime guard now matches the declared contract.

  Error body keeps the existing `{ error }` convention — callers see
  the zod `flatten()` shape on schema failure instead of a bespoke
  "missing field X" string.

  Endpoints with no matching wire schema (e.g. federation peering,
  sync push, task submit, dispute filing, subscription webhooks) are
  untouched — the submission shapes there are ad-hoc input bodies
  that the relay uses to construct wire artifacts, not wire artifacts
  themselves. If a missing schema is later identified as a wire
  artifact, the fix is to add the schema in `@motebit/wire-schemas`
  and wire it in here — never to inline validation in the service.

- 683ab13: Sign every per-task SettlementRecord at the relay (audit follow-up
  #1, relay integration). The protocol-layer primitive shipped in
  the prior commit; this commit makes the relay actually use it.

  ## What changed
  - **Migration v13** (`relay_settlements_signature_columns`): adds
    three nullable columns to `relay_settlements` —
    `issuer_relay_id`, `suite`, `signature`. Backward-compat: rows
    written before this migration carry NULL signatures and remain
    in place.
  - **`tasks.ts` settlement INSERT sites** (3 of them: main relay
    settlement, multi-hop sub-settlement, P2P audit settlement):
    call `signSettlement(...)` from `@motebit/encryption` with the
    relay's private key, persist `issuer_relay_id`/`suite`/
    `signature` alongside the existing columns.

  Going forward, every emitted SettlementRecord carries a signature
  committing the relay to the exact (amount_settled, platform_fee,
  platform_fee_rate, status) tuple. A relay that issues
  inconsistent records to different observers fails self-attestation:
  at most one of the records verifies (delegation-v1.md §6.4).

  ## Concurrency footgun caught + named

  `signSettlement` is async (Ed25519 over canonical bytes). The
  naive placement — `await` inside the `BEGIN`/`COMMIT` block — let
  concurrent receipts interleave their transactions, corrupting
  INSERT-OR-IGNORE semantics. Only 1 of 5 settlements landed in
  the money-loop-concurrency test on first attempt.

  Fix: pre-compute the signature OUTSIDE the synchronous
  transaction. The signature only depends on body fields known
  before BEGIN; lifting it preserves transaction atomicity.
  Comments at each site name this concurrency invariant for future
  maintainers. Caught by the existing
  `money-loop-concurrency.test.ts` "concurrent settlements
  crediting same worker" suite.

  ## Closes the doctrinal commitment

  `services/api/CLAUDE.md` rule 6: "Every truth the relay asserts
  (credential anchor proofs, revocation memos, settlement receipts)
  is independently verifiable onchain without relay contact."
  Federation settlements deliver this through Merkle batching +
  onchain anchoring (relay-federation-v1.md §7.6); per-agent
  settlements now deliver it through embedded signatures. Future
  work could add Merkle batching for per-agent settlements too —
  this commit ships the floor (signature), not the ceiling
  (anchoring).

  All 862 relay tests pass; all 16 drift defenses green.

### Patch Changes

- aa15449: Fix: relay_credentials.anchor_batch_id column missing on fresh DBs
  (latent since credential anchoring shipped 2026-04-10).

  The column was added via an idempotent `ALTER TABLE` inside
  `createCredentialAnchoringTables()`, but that helper runs BEFORE the
  migration that creates `relay_credentials` — `createSyncRelay` calls
  `createFederationTables` (which depends on pairing/data-sync tables
  for later migrations) ahead of `createRelaySchema` (which runs
  migrations). The ALTER silently failed; the migration then created
  `relay_credentials` without the column. Result: the credential
  anchor-proof endpoint was non-functional end-to-end on any fresh
  relay.

  Fix: migration v15 adds the column with a PRAGMA-guarded ALTER
  plus the partial index on unanchored rows that mirrors the v14
  index on `relay_settlements`. Surfaced by the HTTP integration
  test added for the credential anchor-proof endpoint as part of
  the sibling-boundary closure of the anchor-proof auth-allowlist
  fix (services/api CLAUDE.md rule 6).

- Updated dependencies [699ba41]
- Updated dependencies [bce38b7]
- Updated dependencies [9dc5421]
- Updated dependencies [ceb00b2]
- Updated dependencies [4db67e7]
- Updated dependencies [78a5cf1]
- Updated dependencies [8cef783]
- Updated dependencies [38043ff]
- Updated dependencies [e897ab0]
- Updated dependencies [1690469]
- Updated dependencies [7afce18]
- Updated dependencies [c64a2fb]
- Updated dependencies [bd3f7a4]
- Updated dependencies [54158b1]
- Updated dependencies [2641cff]
- Updated dependencies [f567e8d]
- Updated dependencies [7761ae6]
- Updated dependencies [d969e7c]
- Updated dependencies [009f56e]
- Updated dependencies [eba3f2c]
- Updated dependencies [356bae9]
- Updated dependencies [b96387b]
- Updated dependencies [25b14fc]
- Updated dependencies [3539756]
- Updated dependencies [28c46dd]
- Updated dependencies [620394e]
- Updated dependencies [4eb2ebc]
- Updated dependencies [85579ac]
- Updated dependencies [99a7a34]
- Updated dependencies [4edd4ae]
- Updated dependencies [a792355]
- Updated dependencies [2d8b91a]
- Updated dependencies [4ea58fd]
- Updated dependencies [f69d3fb]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [c73189e]
- Updated dependencies [54e5ca9]
- Updated dependencies [9a5b9d5]
- Updated dependencies [3747b7a]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
- Updated dependencies [f60493e]
  - @motebit/sdk@1.0.0
  - @motebit/crypto@1.0.0
  - @motebit/protocol@1.0.0
  - @motebit/wire-schemas@0.2.0
  - @motebit/encryption@0.2.0
  - @motebit/virtual-accounts@0.2.0
  - @motebit/market@0.2.0
  - @motebit/wallet-solana@0.2.0
  - @motebit/persistence@0.1.18
  - @motebit/settlement-rails@0.1.18
  - @motebit/core-identity@0.1.18
  - @motebit/event-log@0.1.18

## 0.1.17

### Patch Changes

- Updated dependencies [b231e9c]
  - @motebit/sdk@0.8.0
  - @motebit/core-identity@0.1.17
  - @motebit/encryption@0.1.17
  - @motebit/event-log@0.1.17
  - @motebit/market@0.1.17
  - @motebit/wallet-solana@0.1.17
  - @motebit/persistence@0.1.17

## 0.1.16

### Patch Changes

- Updated dependencies [9b6a317]
- Updated dependencies
  - @motebit/sdk@0.7.0
  - @motebit/core-identity@0.1.16
  - @motebit/crypto@0.1.16
  - @motebit/event-log@0.1.16
  - @motebit/market@0.1.16
  - @motebit/persistence@0.1.16

## 0.1.15

### Patch Changes

- Updated dependencies [[`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17), [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9), [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842)]:
  - @motebit/sdk@0.6.11
  - @motebit/core-identity@0.1.15
  - @motebit/crypto@0.1.15
  - @motebit/event-log@0.1.15
  - @motebit/market@0.1.15
  - @motebit/persistence@0.1.15

## 0.1.14

### Patch Changes

- Updated dependencies [[`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470), [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61), [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440), [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f), [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f), [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0), [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f), [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05), [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7), [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052), [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26), [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72), [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17), [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9), [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440)]:
  - @motebit/sdk@0.6.10
  - @motebit/core-identity@0.1.14
  - @motebit/crypto@0.1.14
  - @motebit/event-log@0.1.14
  - @motebit/market@0.1.14
  - @motebit/persistence@0.1.14

## 0.1.13

### Patch Changes

- Updated dependencies [[`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e)]:
  - @motebit/sdk@0.6.9
  - @motebit/core-identity@0.1.13
  - @motebit/crypto@0.1.13
  - @motebit/event-log@0.1.13
  - @motebit/market@0.1.13
  - @motebit/persistence@0.1.13

## 0.1.12

### Patch Changes

- Updated dependencies [[`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80)]:
  - @motebit/sdk@0.6.8
  - @motebit/core-identity@0.1.12
  - @motebit/crypto@0.1.12
  - @motebit/event-log@0.1.12
  - @motebit/market@0.1.12
  - @motebit/persistence@0.1.12

## 0.1.11

### Patch Changes

- Updated dependencies [[`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389)]:
  - @motebit/sdk@0.6.7
  - @motebit/core-identity@0.1.11
  - @motebit/crypto@0.1.11
  - @motebit/event-log@0.1.11
  - @motebit/market@0.1.11
  - @motebit/persistence@0.1.11

## 0.1.10

### Patch Changes

- Updated dependencies [[`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7), [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7)]:
  - @motebit/sdk@0.6.6
  - @motebit/core-identity@0.1.10
  - @motebit/crypto@0.1.10
  - @motebit/event-log@0.1.10
  - @motebit/market@0.1.10
  - @motebit/persistence@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies [[`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99)]:
  - @motebit/sdk@0.6.5
  - @motebit/core-identity@0.1.9
  - @motebit/crypto@0.1.9
  - @motebit/event-log@0.1.9
  - @motebit/market@0.1.9
  - @motebit/persistence@0.1.9

## 0.1.8

### Patch Changes

- Updated dependencies [[`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2)]:
  - @motebit/sdk@0.6.4
  - @motebit/core-identity@0.1.8
  - @motebit/crypto@0.1.8
  - @motebit/event-log@0.1.8
  - @motebit/market@0.1.8
  - @motebit/persistence@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [[`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94), [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71)]:
  - @motebit/sdk@0.6.3
  - @motebit/core-identity@0.1.7
  - @motebit/crypto@0.1.7
  - @motebit/event-log@0.1.7
  - @motebit/market@0.1.7
  - @motebit/persistence@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [[`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0), [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb)]:
  - @motebit/sdk@0.6.2
  - @motebit/core-identity@0.1.6
  - @motebit/crypto@0.1.6
  - @motebit/event-log@0.1.6
  - @motebit/market@0.1.6
  - @motebit/persistence@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [[`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1), [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d)]:
  - @motebit/sdk@0.6.1
  - @motebit/core-identity@0.1.5
  - @motebit/crypto@0.1.5
  - @motebit/event-log@0.1.5
  - @motebit/market@0.1.5
  - @motebit/persistence@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [[`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12)]:
  - @motebit/sdk@0.6.0
  - @motebit/core-identity@0.1.4
  - @motebit/crypto@0.1.4
  - @motebit/event-log@0.1.4
  - @motebit/market@0.1.4
  - @motebit/persistence@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [[`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b), [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8), [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88), [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f), [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3), [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c), [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170), [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a), [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64), [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8), [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50), [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671), [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf), [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4), [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87), [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa), [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e), [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546), [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d), [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a), [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462), [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c), [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba), [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf), [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c), [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c), [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b)]:
  - @motebit/sdk@0.5.3
  - @motebit/core-identity@0.1.3
  - @motebit/crypto@0.1.3
  - @motebit/event-log@0.1.3
  - @motebit/market@0.1.3
  - @motebit/persistence@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [[`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc), [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64), [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0), [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8), [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1), [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de), [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879), [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c), [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719), [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2)]:
  - @motebit/sdk@0.5.2
  - @motebit/core-identity@0.1.2
  - @motebit/crypto@0.1.2
  - @motebit/event-log@0.1.2
  - @motebit/market@0.1.2
  - @motebit/persistence@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [[`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606), [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e), [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b), [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc), [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f), [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea), [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7), [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf), [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f), [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1), [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0)]:
  - @motebit/sdk@0.5.1
  - @motebit/core-identity@0.1.1
  - @motebit/crypto@0.1.1
  - @motebit/event-log@0.1.1
  - @motebit/market@0.1.1
  - @motebit/persistence@0.1.1
