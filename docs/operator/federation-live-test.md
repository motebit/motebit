# Federation E2E live test runbook

The `scripts/test-federation-live.mjs` script exercises the full `motebit/relay-federation@1.2` surface against two real cross-cloud relays:

- Phases 1-5 — `@1.0` baseline (Identity / Peering / Discovery / Heartbeat / Cleanup)
- Phases 6-7 — `@1.1` §15 horizon endpoints (witness solicitation + omission dispute, added by retention-policy phase 4b-3)
- Phase 8 — `@1.2` §6.2 federation dispute orchestration vote-request endpoint, validated against the K4 staging mesh (added by §6.2 dispute-orchestration arc)

Phase numbering preserves the original 1-5 sequence; 6 + 7 + 8 land between Phase 4 and Phase 5 because they need an active synthetic peer with a fresh heartbeat, and Phase 5 cleanup must run last.

## When to run

- After any change to `services/relay/src/federation.ts` or `packages/circuit-breaker/`.
- After any change to the `FEDERATION_SUITE` literal (the cryptosuite identifier used in peering + heartbeat signing).
- Quarterly as a recurring liveness probe of the staging federation.

## Prerequisites

The live test uses two real relay deployments. The reference setup uses Fly.io:

| Relay | URL                                  | Config                              |
| ----- | ------------------------------------ | ----------------------------------- |
| A     | `https://motebit-sync-stg.fly.dev`   | `services/relay/fly.staging.toml`   |
| B     | `https://motebit-sync-stg-b.fly.dev` | `services/relay/fly.staging-b.toml` |

Both apps share the **same** `MOTEBIT_API_TOKEN`. The script registers a test agent on B and discovers it from A under that bearer.

The full staging fleet is larger — four relays in a K4 mesh; see "Staging fleet topology" below. The live test exercises only A + B; relays C + D are the §6.2 dispute-orchestration mesh complement that the orchestrator's Phase 8 will use.

To rotate the test token:

```bash
TOKEN=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
for app in motebit-sync-stg motebit-sync-stg-b motebit-sync-stg-c motebit-sync-stg-d; do
  fly secrets set MOTEBIT_API_TOKEN="$TOKEN" -a "$app" --stage
  fly machine restart $(fly machine list -a "$app" --json | jq -r '.[0].id') -a "$app"
done
```

## Run

```bash
TOKEN="<paste-token>"
RELAY_A_URL=https://motebit-sync-stg.fly.dev   RELAY_A_TOKEN="$TOKEN" \
RELAY_B_URL=https://motebit-sync-stg-b.fly.dev RELAY_B_TOKEN="$TOKEN" \
RELAY_C_URL=https://motebit-sync-stg-c.fly.dev \
RELAY_D_URL=https://motebit-sync-stg-d.fly.dev \
node scripts/test-federation-live.mjs
```

A clean pass returns `34/34 PASSED` (20 baseline + 7 §15 + 7 §6.2). Two tests are SKIP-by-design (the script uses a _synthetic_ peer keypair for cleanliness, so cross-relay-peer discovery between the two real relays isn't exercised; that would require a separate "real two-real-peer" setup).

**Phase 8 prerequisite — `MOTEBIT_TEST_VOTE_POLICY` env var on staging relays.** The §6.2 vote-request endpoint defaults to `501 policy_not_configured` per `spec/relay-federation-v1.md` §16.2 mandate-callback semantics. To exercise the deterministic happy path against the K4 mesh, set `MOTEBIT_TEST_VOTE_POLICY=upheld` on every staging peer:

```bash
for app in motebit-sync-stg motebit-sync-stg-b motebit-sync-stg-c motebit-sync-stg-d; do
  fly secrets set MOTEBIT_TEST_VOTE_POLICY=upheld -a "$app" --stage
  fly machine restart $(fly machine list -a "$app" --json | jq -r '.[0].id') -a "$app"
done
```

This is a **STAGING-ONLY** affordance — production relays MUST leave it unset (the relay logs a `relay.test_vote_policy.enabled` warning at startup when set, so prod misconfig surfaces immediately). The Phase 8 sub-phase 8.1/8.2 identity check verifies `vote_policy_configured: true` is reported, so a missing env var fails the test cleanly.

Without `RELAY_C_URL` + `RELAY_D_URL`, Phase 8 skips with a friendly message and the script reports `27/27 PASSED` (legacy 2-relay shape).

## What it validates

- **Phase 1 — Identity exchange (4 tests):** `GET /federation/v1/identity` on both relays returns `motebit/relay-federation@1.2` payloads with distinct Ed25519 keys. The wire-reported `spec` field is anchored to `RELAY_SPEC_VERSION` in `services/relay/src/federation.ts`, which a defensive test in `federation-identity.test.ts` locks to the H1 of `spec/relay-federation-v1.md` — bumping the spec doc without bumping the constant fails CI.
- **Phase 2 — Peering handshake (4 tests):** Synthetic peer A proposes to relay B; B challenges with a nonce; A signs `${relay_id}:${nonce}:${FEDERATION_SUITE}`; B verifies and activates the peer record. The `:${FEDERATION_SUITE}` suffix is critical — it binds the handshake to a specific cryptosuite (`motebit-concat-ed25519-hex-v1`) so a peer attesting under a different suite is rejected.
- **Phase 3 — Federated discovery (4 tests):** Test agent registered on relay B is discoverable through `GET /api/v1/agents/discover` (local) and `POST /federation/v1/discover` (the cross-relay path).
- **Phase 4 — Heartbeat (4 tests):** Heartbeat signs `${relay_id}|${timestamp}|${FEDERATION_SUITE}` (note the `|` separator — distinct from the peering `:` separator); relay verifies the signature, records the timestamp, and rejects payloads with wrong signatures or >5min clock drift.
- **Phase 5 — Cleanup (4 tests):** The synthetic peer is removed via `POST /federation/v1/peer/remove` (also signature-gated); the test agent is left registered. **Note:** the test agent's `expires_at` is 90 days (the relay's standard registration TTL per `services/relay/src/agents.ts:713`), not 15 minutes — earlier versions of this runbook misstated the TTL. Test agents accumulate on staging across runs until the 90-day janitor sweep removes them. For environments where accumulation matters, sign a deregister token with the test agent's keypair before discarding it (current script doesn't; see the inline comment in `scripts/test-federation-live.mjs` Phase 3).
- **Phase 6 — §15 Horizon witness solicitation (4 tests):** Synthetic peer (now active + fresh from Phases 2/4) constructs a `WitnessSolicitationRequest` for `relay_revocation_events` with `EMPTY_FEDERATION_GRAPH_ANCHOR` and signs `canonicalJson(cert_body)` with its private key. Relay B verifies the issuer is a known peer (gate 2), `issuer_id` matches the cert subject's projected operator_id (gate 3), the issuer signature verifies under `motebit-jcs-ed25519-b64-v1` (gate 4), then signs the same canonical bytes as a witness and returns `WitnessSolicitationResponse`. Three negative probes cover signature-fail (403), subject↔issuer mismatch (400), and schema-fail (400). What this validates that `horizon.test.ts` can't: the actual Hono request → schema parse → handler → response chain over real HTTP, JCS canonicalization byte-equality across the wire, the relay's actual `relay_peers` lookup against a peer that completed the real handshake, cross-process Ed25519 verification (Node ↔ `@noble/ed25519`).
- **Phase 7 — §15 Witness-omission dispute (3 tests):** Synthetic peer files `WitnessOmissionDispute` artifacts against Relay B. Three tests cover the schema-validation path (malformed body → 400), the cert-not-found path (well-formed dispute against a fictional cert_signature → 404 + audit persistence under `cert_not_found_in_local_store`), and dispute-rejection determinism (two back-to-back disputes against the same fictional cert each return 404 cleanly, proving the audit-trail-on-rejection path is deterministic). **Live-test scope note:** the full happy-path verifier ladder (window check → cert binding → disputant signature → evidence dispatch) requires an actual horizon cert in Relay B's `relay_horizon_certs` table, which only the periodic `advanceRevocationHorizon` loop produces (1h cadence by default). Future enhancement: an admin-gated `/admin/horizon/advance` route would let the live test trigger one synchronously and exercise the happy path.
- **Phase 8 — §6.2 Federation dispute orchestration vote-request (7 tests):** Validates that the K4 staging mesh's vote-request endpoint (added in `relay-federation@1.2` §16.2) responds correctly across the live wire with each peer's `MOTEBIT_TEST_VOTE_POLICY=upheld` env var wired through to the orchestrator's vote callback. Sub-phases:
  - **8.1** — `stg-c` identity reports `motebit/relay-federation@1.2` + `vote_policy_configured: true`
  - **8.2** — `stg-d` identity reports `motebit/relay-federation@1.2` + `vote_policy_configured: true`
  - **8.3** — Round-1 `VoteRequest` to `stg-b` returns a signed `AdjudicatorVote` with the correct shape (dispute_id, round, suite, signature)
  - **8.4** — `stg-b` vote signature verifies under stg-b's stored public key (cross-process Ed25519 verification, JCS canonical-bytes byte-equality across the wire)
  - **8.5** — Round-binding: round-2 `VoteRequest` returns a round-2 `AdjudicatorVote` (proves §6.5 + §8.3 round binding holds end-to-end on staging)
  - **8.6** — Vote outcome matches `MOTEBIT_TEST_VOTE_POLICY=upheld` (proves the env-var → callback → response wire path)
  - **8.7** — Synthetic dispute_id `dispute-test-${ts}` is stateless on peer side per §16.2 v1 simplification (no cleanup needed)

  **What Phase 8 validates that unit tests can't:** wire-format byte-equality across cross-cloud HTTP, each staging relay's env var wired correctly, K4 mesh peers report @1.2 + `vote_policy_configured: true`, round-binding holds across the wire. **What Phase 8 does NOT validate (covered by unit tests):** full leader-side orchestrator flow (file dispute → /resolve → fan-out → /appeal → final → fund_action). Real allocation + dispute filing requires settlement state painful to synthesize via HTTP-only; covered by `services/relay/src/__tests__/federation-appeal.test.ts`. Aggregation logic (majority, ties, quorum-failure): covered by `federation-orchestrator.test.ts`.

## Common failure modes and fixes

### "Challenge response verification failed" (HTTP 403) on Phase 2 confirm

The script's signing payload doesn't match what the relay verifier expects. Most likely cause: the `FEDERATION_SUITE` constant in `services/relay/src/federation.ts` changed and `scripts/test-federation-live.mjs` wasn't updated. Look at lines 1077 and 1125 of `federation.ts` for the canonical signing payload format.

### "Heartbeat signature verification failed" (HTTP 403) on Phase 4

Same root cause as above, applied to `${relay_id}|${timestamp}|${FEDERATION_SUITE}`. See line 605-608 of `federation.ts`.

### Phase 3 test agent register fails with 401

The two relays don't share the same `MOTEBIT_API_TOKEN`. Re-run the rotation block above and verify both apps received the secret + restarted.

### Both relays unreachable

Check `fly status` across all four staging relays (`motebit-sync-stg{,-b,-c,-d}`). If a machine is in `stopped` state, fly's `auto_stop_machines` parked it; the next request will wake it but Phase 1 may time out on the cold start. Wait 10 seconds and re-run.

## What this does NOT validate

- **§6.2 execution-ledger dispute orchestration happy path.** The K4 staging mesh exists (stg, stg-b, stg-c, stg-d — see "Staging fleet topology"), satisfying the `dispute-v1.md` §6.2 + §6.5 + §6.6 minimum mesh size for a single-operator fleet. The orchestrator's Phase 8 will be added by shape 2 of the §6.2 arc; until then, the live test exercises only the §15 horizon-cert dispute path (Phases 6 + 7) and not the §6 execution-ledger dispute path. Single-operator caveat: K4 validates orchestration code paths, not vote independence.
- **Real cross-relay task forwarding under load.** The script registers a test agent and discovers it; it does not submit a real task that gets routed across the federation boundary. That's an additional scenario.
- **Heartbeat-based peer suspension.** The 3-missed-heartbeat suspension rule is exercised in `federation-chaos.test.ts` against in-memory relays; a real-network test would need a deliberate disconnect (firewall rule, fly machine stop) which this script doesn't do.
- **Recovery semantics after a peer comes back online.** Same — chaos territory, not a single-pass live test.

## Operational cost

Each staging relay (`motebit-sync-stg{-b,-c,-d}`) is a shared-CPU 1x machine on Fly.io with a 1GB volume — approximately $5/month each at current Fly pricing, ~$20/month for the full K4 staging fleet (`stg` + three §6.2 mesh complements). Auto-stop is enabled, so idle hours don't burn full price.

## Staging fleet topology

The staging federation is a K4 mesh of four `motebit-sync-stg{,-b,-c,-d}` apps, all peered bidirectionally. K4 (each leader sees 3 active OTHER peers) is the minimum that satisfies `dispute-v1.md` §6.2 + §6.5 + §6.6 for a single-operator fleet — a 3-relay triangle would give each leader only 2 others, failing the §6.2 quorum floor.

| Relay   | URL                                  | Config                              | Purpose                              |
| ------- | ------------------------------------ | ----------------------------------- | ------------------------------------ |
| A (stg) | `https://motebit-sync-stg.fly.dev`   | `services/relay/fly.staging.toml`   | Live-test "A"; also peered with prod |
| B       | `https://motebit-sync-stg-b.fly.dev` | `services/relay/fly.staging-b.toml` | Live-test "B"                        |
| C       | `https://motebit-sync-stg-c.fly.dev` | `services/relay/fly.staging-c.toml` | §6.2 mesh complement                 |
| D       | `https://motebit-sync-stg-d.fly.dev` | `services/relay/fly.staging-d.toml` | §6.2 mesh complement                 |

To re-establish the mesh from scratch (e.g., after destroying + recreating any apps): `node scripts/staging-federation-mesh.mjs`. Six pair handshakes (n choose 2 with n=4), per-pair failure isolation. Verify via `curl <relay>/federation/v1/peers | jq` — each relay should report 3 active OTHER peers (stg additionally shows prod).

Single-operator caveat: all four relays run in one fly account, so the mesh validates §6.2 orchestration code paths but not vote independence (vote independence is a multi-operator property — see `operator_transparency_stage_2_deferred`).

## Cleanup if not running tests for a while

```bash
for app in motebit-sync-stg-b motebit-sync-stg-c motebit-sync-stg-d; do
  fly apps destroy "$app"
done
```

Removes the §6.2 K4-mesh complement cleanly. The first peer (`motebit-sync-stg`) stays — it's federation-peered with prod and serves as the always-on cross-cloud probe. To rebuild after teardown: `fly deploy --config services/relay/fly.staging-{b,c,d}.toml --remote-only` for each, set the shared `MOTEBIT_API_TOKEN`, then re-run `node scripts/staging-federation-mesh.mjs`.
