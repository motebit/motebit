# Self-host the motebit relay

The motebit relay (`services/api`) ships as a signed multi-arch container image at `ghcr.io/motebit/relay`. A third-party operator can pull, verify, and run a relay alongside motebit's own — full federation peer, full settlement, full task routing — without any code from this repo.

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
cosign verify ghcr.io/motebit/relay:1.0.0 \
  --certificate-identity-regexp 'https://github.com/motebit/motebit/.github/workflows/publish-images.yml@.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'

# Verify the build-provenance attestation (SLSA).
cosign verify-attestation ghcr.io/motebit/relay:1.0.0 \
  --type slsaprovenance \
  --certificate-identity-regexp 'https://github.com/motebit/motebit/.github/workflows/.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

Both verifications must succeed. The first proves the image came from motebit's `publish-images.yml` workflow on motebit's repo. The second proves what source commit, what build steps, what dependencies — the full SLSA envelope.

## Run

The minimal docker-compose stack: see [`docker-compose.example.yml`](docker-compose.example.yml). One relay, one persistent volume for the SQLite database, no external dependencies. Bring it up:

```bash
curl -L https://raw.githubusercontent.com/motebit/motebit/main/docs/operator/docker-compose.example.yml \
     -o docker-compose.yml
docker compose up -d
docker compose logs -f motebit-relay
```

The relay listens on port 3000. `GET /health` returns `200 OK` once the database is up; `GET /.well-known/motebit-transparency.json` returns the operator's signed transparency declaration.

## Federate with motebit

A standalone relay is useful for testing. To act as a peer in the live motebit federation network, the relay needs:

- A unique operator identity (Ed25519 keypair) — not motebit's
- A peer registration handshake with at least one existing peer
- A signed transparency declaration matching the operator's actual processing footprint (see [`docs/doctrine/operator-transparency.md`](../doctrine/operator-transparency.md))

The reference setup that produced motebit's two staging peers (`motebit-sync-stg.fly.dev`, `motebit-sync-stg-b.fly.dev`) is documented at [`federation-live-test.md`](federation-live-test.md) — it covers peer registration, heartbeat signing, and the cross-cloud handshake that proves the federation E2E works. Adapt that for your own operator deployment, and treat the `transparency.ts` declaration in `services/api` as the contract your `/.well-known/motebit-transparency.json` must honour ([`docs/doctrine/operator-transparency.md`](../doctrine/operator-transparency.md)).

## Why this exists

The motebit endgame is "operators run the relay, take the 5% fee on settlement bundles" ([`README.md`](../../README.md) § Three things no one else is building together). A protocol that nobody can run except its author is not a protocol — it's a hosted service in protocol clothes.

Containers + cosign signatures + SBOM + multi-arch builds are the table stakes that turn motebit from "centralized service with verifiable receipts" into "federated network with verifiable everything, including the binary." That's what this surface is for.
