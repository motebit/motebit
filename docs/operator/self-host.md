# Self-host the motebit relay

The motebit relay (`services/relay`) ships as a signed multi-arch container image at `ghcr.io/motebit/relay`. A third-party operator can pull, verify, and run a relay alongside motebit's own — full federation peer, full settlement, full task routing — without any code from this repo.

This is the federation-unblock path: protocol code is on GitHub, npm packages are on npmjs.com, and the relay binary is at ghcr.io. Three artifacts, three registries, one verifiable system.

## Image identity

| Tag                                 | What it points at                                | When to use                                                      |
| ----------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `ghcr.io/motebit/relay:X.Y.Z`       | A specific relay release (cut as `relay-vX.Y.Z`) | Production. Pin a version, verify it, run it.                    |
| `ghcr.io/motebit/relay:sha-<short>` | A specific commit on main                        | Reproducing a specific build, debugging, or pre-release testing. |
| `ghcr.io/motebit/relay:main`        | Floating tag tracking HEAD on main               | Internal dev only. Do not pin in production.                     |

There is no `:latest` tag by design. `:latest` drift is the largest preventable bug class in container distribution; pinning to an explicit version is required of every motebit operator.

## Verify before you run

Every motebit-published image is signed via cosign keyless OIDC + Sigstore and carries a SLSA build-provenance attestation. Verification is mandatory for the same reason every motebit credential carries an Ed25519 signature: the brand is verifiability ([`docs/doctrine/self-attesting-system.md`](../doctrine/self-attesting-system.md)). Don't run an image you haven't verified.

```bash
# Install cosign once: https://docs.sigstore.dev/cosign/installation/

# Verify the keyless signature came from motebit's repo + this exact workflow.
cosign verify ghcr.io/motebit/relay:1.2.0 \
  --certificate-identity-regexp 'https://github.com/motebit/motebit/.github/workflows/publish-images.yml@.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'

# Verify the build-provenance attestation (SLSA). `slsaprovenance1` is the v1
# predicate the build emits; the bare `slsaprovenance` shorthand selects v0.2
# and matches nothing here.
cosign verify-attestation ghcr.io/motebit/relay:1.2.0 \
  --type slsaprovenance1 \
  --certificate-identity-regexp 'https://github.com/motebit/motebit/.github/workflows/.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

Both verifications must succeed. The first proves the image came from motebit's `publish-images.yml` workflow on motebit's repo. The second proves what source commit, what build steps, what dependencies — the full SLSA envelope.

## Run

The minimal docker-compose stack: see [`docker-compose.example.yml`](docker-compose.example.yml). One relay, one persistent volume for the SQLite database, no external dependencies. The relay refuses to start without a master token (`MOTEBIT_API_TOKEN` — every admin, export and sync route is gated by it), and the compose file refuses to start the stack until one is set. Generate one, keep it in a `.env` file beside the compose file, and bring it up:

```bash
curl -L https://raw.githubusercontent.com/motebit/motebit/main/docs/operator/docker-compose.example.yml \
     -o docker-compose.yml
echo "MOTEBIT_API_TOKEN=$(openssl rand -hex 32)" > .env
chmod 600 .env
docker compose up -d
docker compose logs -f motebit-relay
```

The relay listens on port 3000. Operator commands (admin dashboards, state exports, freeze) present that token as `Authorization: Bearer <token>`; `MOTEBIT_RELAY_INSECURE_NO_AUTH` is refused under `NODE_ENV=production`. `GET /health` returns `200 OK` once the database is up; `GET /.well-known/motebit-transparency.json` returns the operator's signed transparency declaration.

## Federate with motebit

A standalone relay is useful for testing. To act as a peer in the live motebit federation network, the relay needs:

- A unique operator identity (Ed25519 keypair) — not motebit's
- A peer registration handshake with at least one existing peer
- A signed transparency declaration matching the operator's actual processing footprint (see [`docs/doctrine/operator-transparency.md`](../doctrine/operator-transparency.md))

The reference setup that produced motebit's two staging peers (`motebit-sync-stg.fly.dev`, `motebit-sync-stg-b.fly.dev`) is documented at [`federation-live-test.md`](federation-live-test.md) — it covers peer registration, heartbeat signing, and the cross-cloud handshake that proves the federation E2E works. Adapt that for your own operator deployment, and treat the `transparency.ts` declaration in `services/relay` as the contract your `/.well-known/motebit-transparency.json` must honour ([`docs/doctrine/operator-transparency.md`](../doctrine/operator-transparency.md)).

### Signed discover — strict by default since 2026-07-21 (1.4)

`POST /federation/v1/discover` requests carry a per-hop sender signature since `relay-federation@1.3` (spec §4.1.1). During the 1.3 rollout the receiver default was **tolerant** (`requireDiscoverSignature: false` — an unsigned discover from an un-upgraded neighbor was accepted with a `federation.discover.unsigned` warning). **Since 2026-07-21 (`relay-federation@1.4`, the announced sunset) the default is `true`**: an unsigned inbound discover rejects with `403`. Run `relay-federation@1.3` or later (it always _signs_ its outbound discovers) and your peers keep interoperating with no action. The flip was announced 2026-06-21 and executed on schedule, per the relay's deprecation discipline. Relaxing it no longer helps an older peer: since `relay-federation@1.5` (relay 1.2.0) every other federation message must name its recipient, so a relay below 1.5 cannot peer with this one at all. Upgrade the whole mesh together.

## Upgrading from 1.1.0

1.2.0 carries every relay security fix since May 2026, and the upgrade is not drop-in. Read this before you change the tag.

**What has been tested.** The published 1.1.0 image was run with seeded data (agents, a listing, plaintext sync conversations and plans, a task), stopped, backed up, and the published 1.2.0 image booted on the same database with the same environment. It started, applied v25–v58, kept the relay key and every agent and listing, redacted the plaintext sync fields, and answered 401 to unauthenticated admin and sync routes. Restoring the cold backup and booting 1.1.0 on it brought everything back. Not tested: boot time on a large database, and migrations that had no rows to act on in that test (v30, v34–v36, v48, v55).

**Back up first.** Stop the relay, copy the SQLite file cold, and export an encrypted backup of the relay key. The 1.2.0 image can do this against the 1.1.0 database without changing it:

```bash
docker run --rm -v /path/to/data:/data \
  -e MOTEBIT_DB_PATH=/data/motebit.db \
  -e MOTEBIT_RELAY_KEY_PASSPHRASE='<your key passphrase>' \
  -e MOTEBIT_RELAY_BACKUP_PASSPHRASE='<a new backup passphrase>' \
  ghcr.io/motebit/relay:1.2.0 node dist/cli.js relay-key export --out /data/relay-key-backup.json
```

Store the backup file and its passphrase offsite, separately ([`services/relay/RUNBOOK-key-recovery.md`](../../services/relay/RUNBOOK-key-recovery.md)). Migrations v25–v58 run automatically at the first boot, forward-only. **Rolling back means restoring the cold backup, never just running the old image:** 1.1.0 starts without complaint on an upgraded database and serves the migrated, redacted data. Some migrations change data for good:

- v30 deletes duplicate settlement rows that share a P2P transaction hash (it keeps the earliest).
- v34–v36 redact stored memory event payloads and the content of memories whose deletion was requested earlier.
- v37 overwrites every plaintext (unencrypted) conversation and plan field held in the sync tables with `[REDACTED]`. Export anything you need from them first.

On a large database the first boot can take a while (v34–v37 and v46 scan whole tables), so give it a longer health-check grace period and watch the `migration.*` log lines.

**Configuration that now refuses to boot:**

- `MOTEBIT_API_TOKEN` is required. 1.1.0 left the admin, sync and export routes open without it.
- `MOTEBIT_RELAY_INSECURE_NO_AUTH` is honoured only when `NODE_ENV` is exactly `development` or `test`.
- Booleans and numbers are parsed strictly: `yes`/`on` and out-of-range values refuse instead of falling back to a default. `X402_TESTNET` now also reads `FALSE` and `0` as mainnet, and mainnet needs `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`.
- An x402 network with no RPC URL refuses. Set a keyed `X402_RPC_URL_<network>`; the public defaults are rate-limited.

**Upgrade these together with the relay:**

- **Federation peers.** 1.2.0 speaks `relay-federation@1.5`: every signed message names its recipient and nonces are single-use, so a 1.1.0 peer cannot handshake, heartbeat, forward or settle with it.
- **Workers and MCP servers.** The relay now authenticates to a worker with its own signed `mcp:call` token, never the master token. A worker on an older `@motebit/mcp-server` answers 401.

**What clients will see change:** reading an agent's listing (`GET /api/v1/agents/:id/listing`) now needs a token, where 1.1.0 answered it unauthenticated (discovery stays public); migration arrivals return 503 and guardian recovery returns 503 `GUARDIAN_RECOVERY_SUSPENDED` (both contained pending a permanent fix); a withdrawal to an EVM (0x) address returns 400 before any debit. Guardians set before the upgrade carry no provenance (v58 is deliberately not backfilled), so users must set them again under their current key before recovery can ever apply.

**After the first boot:** review `relay_settlement_payee_corrections` rows with `prior_verification_status = 'verified'` (v48 leaves them for you to re-check), review `relay_allocations.review_reason` flags (v55), and read the identity-authority census at `GET /api/v1/admin/identity-authority/census`.

## Why this exists

The motebit endgame is "operators run the relay, take the 5% fee on settlement bundles" ([`README.md`](../../README.md) § Three things no one else is building together). A protocol that nobody can run except its author is not a protocol — it's a hosted service in protocol clothes.

Containers + cosign signatures + SBOM + multi-arch builds are the table stakes that turn motebit from "centralized service with verifiable receipts" into "federated network with verifiable everything, including the binary." That's what this surface is for.
