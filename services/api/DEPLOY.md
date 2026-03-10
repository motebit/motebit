# Deploying the Motebit Sync Relay

The sync relay is a stateless event fan-out server. It stores events in SQLite, authenticates devices via Ed25519 signed JWTs, and broadcasts state changes to all connected devices on the same motebit identity.

## Quick Start (Fly.io)

### Prerequisites

- [flyctl](https://fly.io/docs/flyctl/install/) installed
- Fly.io account (free tier works)

### 1. Create app + persistent volume

```bash
cd services/api
flyctl apps create motebit-sync
flyctl volumes create motebit_data --region sjc --size 1
```

### 2. Set secrets

```bash
flyctl secrets set \
  MOTEBIT_API_TOKEN="<generate-a-strong-random-token>" \
  MOTEBIT_DB_PATH="/data/motebit.db"
```

`MOTEBIT_API_TOKEN` is the master token — gates admin endpoints and device registration. Generate with `openssl rand -hex 32` or similar.

### 3. Deploy

```bash
flyctl deploy --remote-only
```

The relay will be live at `https://motebit-sync.fly.dev`.

### 4. Verify

```bash
curl https://motebit-sync.fly.dev/health
# → { "status": "ok" }
```

## CI/CD (GitHub Actions)

The workflow at `.github/workflows/deploy-sync.yml` auto-deploys on push to `main` when files in `services/api/` or dependent packages change.

**Required GitHub secret:** `FLY_API_TOKEN` — generate via `flyctl tokens create deploy`.

## Environment Variables

| Variable                     | Required | Default      | Purpose                              |
| ---------------------------- | -------- | ------------ | ------------------------------------ |
| `PORT`                       | No       | `3000`       | HTTP/WS listen port                  |
| `NODE_ENV`                   | No       | `production` | Runtime environment                  |
| `MOTEBIT_DB_PATH`            | Yes      | `:memory:`   | SQLite database file path            |
| `MOTEBIT_API_TOKEN`          | Yes      | —            | Master bearer token for admin routes |
| `MOTEBIT_CORS_ORIGIN`        | No       | `*`          | CORS origin whitelist                |
| `MOTEBIT_ENABLE_DEVICE_AUTH` | No       | `true`       | Require per-device signed tokens     |

## Architecture

```
Device A (desktop)  ──signed JWT──▶  ┌──────────────┐  ◀──signed JWT──  Device B (web)
                                     │  Sync Relay   │
Device C (mobile)   ──signed JWT──▶  │  (Hono + WS)  │
                                     │  SQLite (WAL)  │
Admin Dashboard     ──master token─▶ └──────────────┘
```

- **Auth**: Devices authenticate with 5-minute Ed25519 signed JWTs. No passwords, no sessions.
- **Storage**: SQLite in WAL mode. Schema auto-creates on first boot (v11).
- **Transport**: REST (HTTP polling, 30s default) + WebSocket (real-time fan-out).
- **Data**: Events, conversations, memories, identities, devices, audit log, goals, plans.

## Self-Hosting (Docker)

```bash
docker build -t motebit-sync services/api/

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
ExecStart=/usr/bin/node dist/index.js
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
