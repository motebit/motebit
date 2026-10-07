# Deploying the Motebit Sync Relay

The sync relay is a stateless event fan-out server. It stores events in SQLite, authenticates devices via Ed25519 signed JWTs, and broadcasts state changes to all connected devices on the same motebit identity.

## Quick Start (Fly.io)

### Prerequisites

- [flyctl](https://fly.io/docs/flyctl/install/) installed
- Fly.io account (free tier works)

### 1. Create app + persistent volume

```bash
cd services/relay
flyctl apps create motebit-sync
flyctl volumes create motebit_data --region sjc --size 1
```

### 2. Set secrets

```bash
flyctl secrets set \
  MOTEBIT_API_TOKEN="<generate-a-strong-random-token>" \
  MOTEBIT_DB_PATH="/data/motebit.db"
```

`MOTEBIT_API_TOKEN` is the master token — gates admin endpoints and device registration. Generate with `openssl rand -hex 32` or similar. The relay refuses to start when it is unset or empty (`MOTEBIT_API_TOKEN is required…` on stderr, exit 1): every master-token route is installed from it, so a relay without it would serve them unauthenticated.

### 3. Deploy

```bash
flyctl deploy --remote-only
```

The relay will be live at `https://relay.motebit.com`.

### 4. Verify

```bash
curl https://relay.motebit.com/health
# → { "status": "ok" }
```

## CI/CD (GitHub Actions)

The workflow at `.github/workflows/deploy-sync.yml` auto-deploys on push to `main` when files in `services/relay/` or dependent packages change.

**Required GitHub secret:** `FLY_API_TOKEN` — generate via `flyctl tokens create deploy`.

## Environment Variables

| Variable                               | Required | Default      | Purpose                                                                                                                                                                                                                    |
| -------------------------------------- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                 | No       | `3000`       | HTTP/WS listen port                                                                                                                                                                                                        |
| `NODE_ENV`                             | No       | `production` | Runtime environment                                                                                                                                                                                                        |
| `MOTEBIT_DB_PATH`                      | Yes      | `:memory:`   | SQLite database file path                                                                                                                                                                                                  |
| `MOTEBIT_API_TOKEN`                    | Yes      | —            | Master bearer token for admin routes; boot is refused without it                                                                                                                                                           |
| `MOTEBIT_RELAY_INSECURE_NO_AUTH`       | No       | unset        | Local development only: `1` starts with no master token, every master-token route open (warns at boot). Honoured only when `NODE_ENV` is exactly `development` or `test`; any other value, unset included, refuses to boot |
| `MOTEBIT_CORS_ORIGIN`                  | No       | `*`          | CORS origin whitelist                                                                                                                                                                                                      |
| `MOTEBIT_ENABLE_DEVICE_AUTH`           | No       | `true`       | Require per-device signed tokens                                                                                                                                                                                           |
| `MOTEBIT_EMERGENCY_FREEZE`             | No       | `false`      | Kill switch: `true` boots frozen (every money write refused)                                                                                                                                                               |
| `MOTEBIT_PLATFORM_FEE_RATE`            | No       | `0.05`       | Settlement fee rate in [0, 1)                                                                                                                                                                                              |
| `MOTEBIT_FREE_CREDIT_USD`              | No       | `0` (off)    | One-time free credit per new motebit, USD                                                                                                                                                                                  |
| `MOTEBIT_FREE_CREDIT_IP_DAILY_CAP`     | No       | `10`         | Max free-credit grants per source IP per UTC day                                                                                                                                                                           |
| `MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD` | No       | `25`         | Global free-credit budget per UTC day, USD                                                                                                                                                                                 |

**Strict parsing (money and safety settings).** Every relay variable that moves, prices or caps money, paces a money loop, or is a safety/security switch is parsed exactly at boot; a SET value outside its form refuses to boot with `RelayEnvConfigError` naming the variable and the accepted form — never a silent default. Booleans (`MOTEBIT_EMERGENCY_FREEZE`, `MOTEBIT_ENABLE_DEVICE_AUTH`, `MOTEBIT_ALLOW_PRIVATE_ENDPOINTS`, `MOTEBIT_RELAY_ISSUE_CREDENTIALS`, `MOTEBIT_RELAY_INSECURE_NO_AUTH`, `X402_TESTNET`, `MOTEBIT_FEDERATION_ENABLED`, `MOTEBIT_FEDERATION_AUTO_ACCEPT`, `MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE`): `true`/`1` or `false`/`0` (case-insensitive, trimmed); empty means the default; `yes`, `on`, `y`, `ture` refuse. USD amounts (`MOTEBIT_FREE_CREDIT_USD` ≤ 1000, `MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD` ≤ 1000000): digits with an optional `.` and up to 6 decimals — no sign, exponent, hex or separators. Rate (`MOTEBIT_PLATFORM_FEE_RATE`): `0` or `0.` plus up to 6 digits, in [0, 1). Counts (`MOTEBIT_FREE_CREDIT_IP_DAILY_CAP` 0–1000000, `MOTEBIT_FEDERATION_MAX_PEERS` 0–10000, `MOTEBIT_*RECONCILIATION_INTERVAL_MS` 1–86400000): digits only. An unset variable keeps its documented default.

## Architecture

```
Device A (desktop)  ──signed JWT──▶  ┌──────────────┐  ◀──signed JWT──  Device B (web)
                                     │  Sync Relay   │
Device C (mobile)   ──signed JWT──▶  │  (Hono + WS)  │
                                     │  SQLite (WAL)  │
Operator console    ──master token─▶ └──────────────┘
```

- **Auth**: Devices authenticate with 5-minute Ed25519 signed JWTs. No passwords, no sessions.
- **Storage**: SQLite in WAL mode. Schema auto-creates on first boot (v11).
- **Transport**: REST (HTTP polling, 30s default) + WebSocket (real-time fan-out).
- **Data**: Events, conversations, memories, identities, devices, audit log, goals, plans.

## Self-Hosting (Docker)

```bash
docker build -t motebit-sync services/relay/

docker run -d \
  --name motebit-sync \
  -p 3000:3000 \
  -e MOTEBIT_DB_PATH=/data/motebit.db \
  -e MOTEBIT_API_TOKEN="$(openssl rand -hex 32)" \
  -v motebit_data:/data \
  motebit-sync
```

## Self-Hosting (systemd)

```ini
[Unit]
Description=Motebit Sync Relay
After=network.target

[Service]
Type=simple
User=motebit
WorkingDirectory=/opt/motebit-sync
ExecStart=/usr/bin/node dist/server.js
Restart=always
Environment="NODE_ENV=production"
Environment="PORT=3000"
Environment="MOTEBIT_DB_PATH=/var/lib/motebit/motebit.db"
Environment="MOTEBIT_API_TOKEN=<token>"

[Install]
WantedBy=multi-user.target
```

## Connecting Clients

Once deployed, users enter the relay URL in:

- **Web app**: Click sync icon (cloud) → enter URL → Connect
- **Desktop app**: Settings → Sync → enter relay URL
- **CLI**: `motebit --sync-url https://your-relay.example.com`

The URL is saved locally and auto-reconnects on subsequent launches.

## Cost

Fly.io free tier: 3 shared VMs, 1 GB persistent volume. A single `shared-cpu-1x` (256 MB RAM) handles SQLite relay workloads for many devices. Effectively free at small scale.
