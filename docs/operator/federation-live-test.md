# Federation E2E live test runbook

The `scripts/test-federation-live.mjs` script exercises the full `motebit/relay-federation@1.1` surface against two real cross-cloud relays:

- Phases 1-5 — `@1.0` baseline (Identity / Peering / Discovery / Heartbeat / Cleanup)
- Phases 6-7 — `@1.1` §15 horizon endpoints (witness solicitation + omission dispute, added by retention-policy phase 4b-3)

Phase numbering preserves the original 1-5 sequence; 6 + 7 land between Phase 4 and Phase 5 because they need an active synthetic peer with a fresh heartbeat, and Phase 5 cleanup must run last.

## When to run

- After any change to `services/relay/src/federation.ts` or `packages/circuit-breaker/`.
- After any change to the `FEDERATION_SUITE` literal (the cryptosuite identifier used in peering + heartbeat signing).
- Quarterly as a recurring liveness probe of the staging federation.

## Prerequisites

Two real relay deployments are required. The reference setup uses Fly.io:

| Relay | URL                                  | Config                              |
| ----- | ------------------------------------ | ----------------------------------- |
| A     | `https://motebit-sync-stg.fly.dev`   | `services/relay/fly.staging.toml`   |
| B     | `https://motebit-sync-stg-b.fly.dev` | `services/relay/fly.staging-b.toml` |

Both apps share the **same** `MOTEBIT_API_TOKEN`. The script registers a test agent on B and discovers it from A under that bearer.

To rotate the test token:

```bash
TOKEN=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
fly secrets set MOTEBIT_API_TOKEN="$TOKEN" -a motebit-sync-stg --stage
fly secrets set MOTEBIT_API_TOKEN="$TOKEN" -a motebit-sync-stg-b --stage
fly machine restart $(fly machine list -a motebit-sync-stg --json | jq -r '.[0].id') -a motebit-sync-stg
fly machine restart $(fly machine list -a motebit-sync-stg-b --json | jq -r '.[0].id') -a motebit-sync-stg-b
```

## Run

```bash
TOKEN="<paste-token>"
RELAY_A_URL=https://motebit-sync-stg.fly.dev   RELAY_A_TOKEN="$TOKEN" \
RELAY_B_URL=https://motebit-sync-stg-b.fly.dev RELAY_B_TOKEN="$TOKEN" \
node scripts/test-federation-live.mjs
```

A clean pass returns `27/27 PASSED` (20 baseline + 7 §15). Two tests are SKIP-by-design (the script uses a _synthetic_ peer keypair for cleanliness, so cross-relay-peer discovery between the two real relays isn't exercised; that would require a separate "real two-real-peer" setup).

## What it validates

- **Phase 1 — Identity exchange (4 tests):** `GET /federation/v1/identity` on both relays returns `motebit/relay-federation@1.1`-spec-conformant payloads with distinct Ed25519 keys (the route is unchanged from `@1.0`; minor-version bumps are additive — §3-14 stay byte-compatible).
- **Phase 2 — Peering handshake (4 tests):** Synthetic peer A proposes to relay B; B challenges with a nonce; A signs `${relay_id}:${nonce}:${FEDERATION_SUITE}`; B verifies and activates the peer record. The `:${FEDERATION_SUITE}` suffix is critical — it binds the handshake to a specific cryptosuite (`motebit-concat-ed25519-hex-v1`) so a peer attesting under a different suite is rejected.
- **Phase 3 — Federated discovery (4 tests):** Test agent registered on relay B is discoverable through `GET /api/v1/agents/discover` (local) and `POST /federation/v1/discover` (the cross-relay path).
- **Phase 4 — Heartbeat (4 tests):** Heartbeat signs `${relay_id}|${timestamp}|${FEDERATION_SUITE}` (note the `|` separator — distinct from the peering `:` separator); relay verifies the signature, records the timestamp, and rejects payloads with wrong signatures or >5min clock drift.
- **Phase 5 — Cleanup (4 tests):** The synthetic peer is removed via `POST /federation/v1/peer/remove` (also signature-gated); the test agent is left registered. **Note:** the test agent's `expires_at` is 90 days (the relay's standard registration TTL per `services/relay/src/agents.ts:713`), not 15 minutes — earlier versions of this runbook misstated the TTL. Test agents accumulate on staging across runs until the 90-day janitor sweep removes them. For environments where accumulation matters, sign a deregister token with the test agent's keypair before discarding it (current script doesn't; see the inline comment in `scripts/test-federation-live.mjs` Phase 3).
- **Phase 6 — §15 Horizon witness solicitation (4 tests):** Synthetic peer (now active + fresh from Phases 2/4) constructs a `WitnessSolicitationRequest` for `relay_revocation_events` with `EMPTY_FEDERATION_GRAPH_ANCHOR` and signs `canonicalJson(cert_body)` with its private key. Relay B verifies the issuer is a known peer (gate 2), `issuer_id` matches the cert subject's projected operator_id (gate 3), the issuer signature verifies under `motebit-jcs-ed25519-b64-v1` (gate 4), then signs the same canonical bytes as a witness and returns `WitnessSolicitationResponse`. Three negative probes cover signature-fail (403), subject↔issuer mismatch (400), and schema-fail (400). What this validates that `horizon.test.ts` can't: the actual Hono request → schema parse → handler → response chain over real HTTP, JCS canonicalization byte-equality across the wire, the relay's actual `relay_peers` lookup against a peer that completed the real handshake, cross-process Ed25519 verification (Node ↔ `@noble/ed25519`).
- **Phase 7 — §15 Witness-omission dispute (3 tests):** Synthetic peer files `WitnessOmissionDispute` artifacts against Relay B. Three tests cover the schema-validation path (malformed body → 400), the cert-not-found path (well-formed dispute against a fictional cert_signature → 404 + audit persistence under `cert_not_found_in_local_store`), and dispute-rejection determinism (two back-to-back disputes against the same fictional cert each return 404 cleanly, proving the audit-trail-on-rejection path is deterministic). **Live-test scope note:** the full happy-path verifier ladder (window check → cert binding → disputant signature → evidence dispatch) requires an actual horizon cert in Relay B's `relay_horizon_certs` table, which only the periodic `advanceRevocationHorizon` loop produces (1h cadence by default). Future enhancement: an admin-gated `/admin/horizon/advance` route would let the live test trigger one synchronously and exercise the happy path.

## Common failure modes and fixes

### "Challenge response verification failed" (HTTP 403) on Phase 2 confirm

The script's signing payload doesn't match what the relay verifier expects. Most likely cause: the `FEDERATION_SUITE` constant in `services/relay/src/federation.ts` changed and `scripts/test-federation-live.mjs` wasn't updated. Look at lines 1077 and 1125 of `federation.ts` for the canonical signing payload format.

### "Heartbeat signature verification failed" (HTTP 403) on Phase 4

Same root cause as above, applied to `${relay_id}|${timestamp}|${FEDERATION_SUITE}`. See line 605-608 of `federation.ts`.

### Phase 3 test agent register fails with 401

The two relays don't share the same `MOTEBIT_API_TOKEN`. Re-run the rotation block above and verify both apps received the secret + restarted.

### Both relays unreachable

Check `fly status -a motebit-sync-stg` and `fly status -a motebit-sync-stg-b`. If a machine is in `stopped` state, fly's `auto_stop_machines` parked it; the next request will wake it but Phase 1 may time out on the cold start. Wait 10 seconds and re-run.

## What this does NOT validate

- **§6.2 dispute orchestration.** Adjudicator quorum requires ≥3 peers; staging only has 2. Deferred until a third peer is deployed.
- **Real cross-relay task forwarding under load.** The script registers a test agent and discovers it; it does not submit a real task that gets routed across the federation boundary. That's an additional scenario.
- **Heartbeat-based peer suspension.** The 3-missed-heartbeat suspension rule is exercised in `federation-chaos.test.ts` against in-memory relays; a real-network test would need a deliberate disconnect (firewall rule, fly machine stop) which this script doesn't do.
- **Recovery semantics after a peer comes back online.** Same — chaos territory, not a single-pass live test.

## Operational cost

`motebit-sync-stg-b` is a shared-CPU 1x machine on Fly.io with a 1GB volume. Approximately $5/month at current Fly pricing. Auto-stop is enabled, so idle hours don't burn full price.

## Cleanup if not running tests for a while

```bash
fly apps destroy motebit-sync-stg-b
```

Removes the second peer cleanly. The first peer (`motebit-sync-stg`) stays — it's federation-peered with prod and serves as the always-on cross-cloud probe.
