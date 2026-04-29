# Motebit Operations Runbook

Last updated: 2026-04-03

Motebit, Inc. — Delaware C Corp (EIN 41-4957563, file #10549131).
Solo founder. Bus factor = 1. This document exists so someone else can take over.

---

## 1. Infrastructure Overview

| Service    | Fly.io App           | URL                                  | Region | Volume                      |
| ---------- | -------------------- | ------------------------------------ | ------ | --------------------------- |
| Sync Relay | `motebit-sync`       | `https://relay.motebit.com`          | sjc    | `motebit_data` @ `/data`    |
| Web Search | `motebit-web-search` | `https://motebit-web-search.fly.dev` | sjc    | `web_search_data` @ `/data` |
| Read URL   | `motebit-read-url`   | `https://motebit-read-url.fly.dev`   | sjc    | `read_url_data` @ `/data`   |
| Embed      | `motebit-embed`      | `https://motebit-embed.fly.dev`      | sjc    | none                        |

All services run Node 22 Alpine containers. Health checks at `GET /health` every 15s.

---

## 2. Relay Deployment (`services/api/`)

### Deploy

```bash
# From repo root
fly deploy -a motebit-sync --config services/api/fly.toml --dockerfile services/api/Dockerfile
```

Or use the full automated script:

```bash
./scripts/deploy-money-loop.sh
```

### Environment Variables

Set via `fly secrets set -a motebit-sync KEY=VALUE`.

| Variable                          | Required   | Default        | Description                                                                                    |
| --------------------------------- | ---------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `MOTEBIT_API_TOKEN`               | Yes        | --             | Master bearer token for admin API access                                                       |
| `MOTEBIT_DB_PATH`                 | Yes (prod) | `:memory:`     | SQLite database path. Set in `fly.toml` to `/data/motebit.db`                                  |
| `MOTEBIT_CORS_ORIGIN`             | No         | --             | Allowed CORS origins (comma-separated)                                                         |
| `MOTEBIT_ENABLE_DEVICE_AUTH`      | No         | `true`         | Ed25519 device auth. Set `false` to disable                                                    |
| `MOTEBIT_RELAY_ISSUE_CREDENTIALS` | No         | `false`        | Set `true` to enable relay co-signing of AgentReputationCredentials                            |
| `MOTEBIT_RELAY_KEY_PASSPHRASE`    | No         | --             | AES-256-GCM passphrase for relay private key encryption at rest. Omit for plaintext (dev only) |
| `X402_PAY_TO_ADDRESS`             | Yes        | --             | Platform USDC wallet address for settlement                                                    |
| `X402_NETWORK`                    | No         | `eip155:84532` | CAIP-2 network identifier                                                                      |
| `X402_FACILITATOR_URL`            | No         | --             | x402 facilitator endpoint                                                                      |
| `X402_TESTNET`                    | No         | `true`         | Set `false` for mainnet. Defaults to testnet unless explicitly `false`                         |
| `MOTEBIT_FEDERATION_ENDPOINT_URL` | No         | --             | This relay's public URL for federation peering                                                 |
| `MOTEBIT_FEDERATION_DISPLAY_NAME` | No         | --             | Human-readable relay name for federation                                                       |
| `STRIPE_SECRET_KEY`               | No         | --             | Stripe billing (both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set to enable)        |
| `STRIPE_WEBHOOK_SECRET`           | No         | --             | Stripe webhook verification secret                                                             |
| `STRIPE_CURRENCY`                 | No         | --             | Stripe billing currency                                                                        |
| `PORT`                            | No         | `3000`         | HTTP listen port. Set in `fly.toml`                                                            |
| `NODE_ENV`                        | No         | --             | Set to `production` in `fly.toml`                                                              |
| `LOG_LEVEL`                       | No         | `info`         | Structured log level: `debug`, `info`, `warn`, `error`                                         |

### Health Check

```bash
curl https://relay.motebit.com/health
```

### Logs

```bash
fly logs -a motebit-sync              # Live tail
fly logs -a motebit-sync --no-tail    # Recent logs
```

Logs are structured JSON with correlation IDs (`x-correlation-id` header).

### Database

SQLite in WAL mode on a persistent Fly.io volume at `/data/motebit.db`.

**Backup:**

```bash
# SSH into the machine
fly ssh console -a motebit-sync

# Inside the machine -- use SQLite .backup (safe with WAL)
sqlite3 /data/motebit.db ".backup /data/motebit-backup-$(date +%Y%m%d).db"

# Copy backup out
fly ssh sftp get /data/motebit-backup-YYYYMMDD.db -a motebit-sync
```

**Fly.io volume snapshots** are also available (check Fly dashboard). Volumes are snapshotted automatically.

**If database is corrupted:**

1. Restore from Fly.io volume snapshot (Fly dashboard > Volumes > Snapshots)
2. Or restore from manual backup
3. The event log is append-only -- clients can re-sync from their local event logs

---

## 3. Service Deployment

### Web Search (`services/web-search/`)

```bash
fly deploy . -a motebit-web-search --config services/web-search/fly.toml --dockerfile services/web-search/Dockerfile
```

Note: build context is repo root (Dockerfile copies `packages/` and `services/web-search/`).

| Variable                     | Required | Default                | Description                                            |
| ---------------------------- | -------- | ---------------------- | ------------------------------------------------------ |
| `MOTEBIT_PORT`               | No       | `3200`                 | Listen port                                            |
| `MOTEBIT_DB_PATH`            | No       | `./data/web-search.db` | SQLite path                                            |
| `MOTEBIT_IDENTITY_PATH`      | No       | `./motebit.md`         | Path to identity file                                  |
| `MOTEBIT_PRIVATE_KEY_HEX`    | Yes      | --                     | Ed25519 private key hex for receipt signing            |
| `MOTEBIT_AUTH_TOKEN`         | No       | --                     | Bearer token for incoming requests                     |
| `MOTEBIT_SYNC_URL`           | Yes      | --                     | Relay URL (e.g., `https://relay.motebit.com`)          |
| `MOTEBIT_API_TOKEN`          | Yes      | --                     | Relay API token                                        |
| `BRAVE_SEARCH_API_KEY`       | Yes      | --                     | Brave Search API key                                   |
| `MOTEBIT_PUBLIC_URL`         | Yes      | --                     | This service's public URL                              |
| `MOTEBIT_DELEGATE_READ_URL`  | No       | --                     | Set to enable multi-hop delegation to read-url service |
| `MOTEBIT_DELEGATE_TARGET_ID` | No       | --                     | Motebit ID of the read-url service for delegation      |

### Read URL (`services/read-url/`)

```bash
fly deploy . -a motebit-read-url --config services/read-url/fly.toml --dockerfile services/read-url/Dockerfile
```

| Variable                  | Required | Default              | Description               |
| ------------------------- | -------- | -------------------- | ------------------------- |
| `MOTEBIT_PORT`            | No       | `3200`               | Listen port               |
| `MOTEBIT_DB_PATH`         | No       | `./data/read-url.db` | SQLite path               |
| `MOTEBIT_IDENTITY_PATH`   | No       | `./motebit.md`       | Path to identity file     |
| `MOTEBIT_PRIVATE_KEY_HEX` | Yes      | --                   | Ed25519 private key hex   |
| `MOTEBIT_SYNC_URL`        | No       | --                   | Relay URL                 |
| `MOTEBIT_API_TOKEN`       | No       | --                   | Relay API token           |
| `MOTEBIT_PUBLIC_URL`      | No       | --                   | This service's public URL |

### Embed (`services/embed/`)

```bash
fly deploy -a motebit-embed --config services/embed/fly.toml --dockerfile services/embed/Dockerfile
```

| Variable       | Required | Default | Description |
| -------------- | -------- | ------- | ----------- |
| `MOTEBIT_PORT` | No       | `3200`  | Listen port |

No persistent volume. Stateless embedding service.

---

## 4. npm Publishing

### Published Packages

| Package                    | npm Name            | License    |
| -------------------------- | ------------------- | ---------- |
| `packages/protocol/`       | `@motebit/protocol` | Apache-2.0 |
| `packages/sdk/`            | `@motebit/sdk`      | Apache-2.0 |
| `packages/crypto/`         | `@motebit/crypto`   | Apache-2.0 |
| `packages/verifier/`       | `@motebit/verifier` | Apache-2.0 |
| `packages/verify/`         | `@motebit/verify`   | Apache-2.0 |
| `packages/create-motebit/` | `create-motebit`    | Apache-2.0 |
| `apps/cli/`                | `motebit`           | BSL-1.1    |

All other packages are `"private": true` and not published.

### Publish Workflow

Uses `@changesets/cli` with `@changesets/changelog-github`.

```bash
# 1. Create changeset (interactive -- picks packages + bump type)
pnpm changeset

# 2. Apply version bumps
pnpm version-packages

# 3. Build all
pnpm run build

# 4. Publish to npm
pnpm release
```

### 1.0 Coordinated Release — Exact Sequence (automated via changesets/action)

Motebit uses the `changesets/action` GitHub Actions flow (`.github/workflows/release.yml`),
**not** manual `pnpm release` locally. Every push to `main` triggers the workflow.
When pending changesets exist in `.changeset/*.md`, the action opens a
"Version Packages" PR instead of publishing directly. Merging that PR re-triggers
the workflow, which then publishes to npm.

```bash
# 0. Sanity locally before push — the pre-push hook also runs this matrix
pnpm -w check
pnpm -w lint
pnpm -w test
git status
```

**Step 1. Push commits to main.**

```bash
git push origin main
```

This triggers `.github/workflows/release.yml`. The workflow:

- Runs `pnpm --filter` tests against all 12 published packages
- Calls `changesets/action` — which detects pending changesets and opens
  (or updates) a PR titled **"Version Packages"** containing:
  - `package.json` version bumps for each package whose own changesets fired (independent versioning per [release-versioning doctrine](../doctrine/release-versioning.md))
  - Generated `CHANGELOG.md` entries compiled from the changeset bodies
  - Deletion of the consumed `.changeset/*.md` files

**Step 2. Review the "Version Packages" PR on GitHub.**

Open it. Check:

- Each package's bump matches the changesets that targeted it (no fixed-group cascade — `updateInternalDependencies: "patch"` is the only automatic propagation)
- CHANGELOG entries read correctly — especially the major-bump narratives
- The stale auto-generated patch stubs are NOT in the PR (we deleted them pre-push)
- No unexpected package included in the bump

**Step 3. Merge the "Version Packages" PR.**

Merging triggers the workflow AGAIN. This time `.changeset/` is empty (consumed),
so `changesets/action` switches modes and runs:

```bash
pnpm release   # pnpm -r publish --access=public (under the hood)
```

The workflow then runs a **post-publish smoke test automatically**:

- `npx create-motebit@latest test-agent --yes` → `node verify.js`
- `npx motebit@latest --version`

If the smoke test passes, 1.0 is live.

**Step 4. Post-publish operator step (manual — the action doesn't do deprecation).**

```bash
npm deprecate @motebit/verify@0.7.0 \
  "Superseded by @motebit/verify@1.x — the canonical CLI. For the library, see @motebit/crypto."
```

The current deprecation message on `0.7.0` dates from 2026-04-09 (verify↔crypto
rename) and still claims "Same MIT license" — correct then, stale at 1.0
publish. Run this immediately after the Version Packages PR merges and the
publish workflow finishes to close the stale-message window to minutes.

### Post-publish verification (5 minutes)

```bash
# latest dist-tag should now be 1.0.0
npm view @motebit/protocol version
npm view @motebit/sdk version
npm view @motebit/crypto version
npm view @motebit/verifier version
npm view @motebit/verify version
npm view create-motebit version
npm view motebit version

# 0.7.0 deprecation message should be the new one
npm view @motebit/verify@0.7.0 deprecated

# 1.0.0 should have NO deprecation flag
npm view @motebit/verify@1.0.0 deprecated  # expected: undefined

# Licenses
npm view @motebit/protocol license  # expected: Apache-2.0
npm view motebit license            # expected: BSL-1.1
```

### GitHub Action post-publish migration (one-line follow-up)

After 1.0 is on npm, `packages/github-action/action.yml` can swap from
the pinned `create-motebit@0.8.0` wrapper to the canonical CLI:

```diff
-        OUTPUT=$(npx --yes create-motebit@0.8.0 verify "$FILE" 2>&1)
+        OUTPUT=$(npx --yes @motebit/verify@1.0.0 "$FILE" 2>&1)
```

README text in `packages/github-action/README.md` also gets a small sweep.
See the inline comment in `action.yml` for the exact swap point.

### Emergency Patch

```bash
# Fix the code, then:
pnpm changeset           # Create changeset
pnpm version-packages    # Bump versions
pnpm run build           # Build
pnpm release             # Publish
git push --follow-tags   # Push version commits + tags
```

---

## 5. Inspector Dashboard

Located at `apps/inspector/`. Connect to relay via environment:

| Variable          | Description                                   |
| ----------------- | --------------------------------------------- |
| `VITE_API_URL`    | Relay URL (e.g., `https://relay.motebit.com`) |
| `VITE_MOTEBIT_ID` | Agent motebit ID to monitor                   |
| `VITE_API_TOKEN`  | Relay API token                               |

```bash
cd apps/inspector && pnpm dev
```

12 tabs: State, Memory, Behavior, Events, Audit, Goals, Plans, Conversations, Devices, Gradient, Trust, Credentials.

Polls relay API every 2 seconds. Fleet-shaped views (federation peers, withdrawals queue, credential anchoring) live in `apps/operator/`.

---

## 6. Operator Console

Located at `apps/operator/`. Fleet-scoped views for the operator who runs the relay (master-token gated).

| Variable         | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `VITE_API_URL`   | Relay URL (e.g., `https://relay.motebit.com`)                 |
| `VITE_API_TOKEN` | Relay master bearer token (`MOTEBIT_API_TOKEN` on the server) |

```bash
cd apps/operator && pnpm dev
```

9 tabs: Withdrawals, Federation Peers, Transparency posture, Disputes, Fees, Credential Anchoring, Reconciliation, Receipts, Freeze. The Reconciliation tab is the daily-health signal (5-rule ledger invariant check); Receipts is the byte-identical canonical-JSON lookup for re-verifying a stored ExecutionReceipt offline; Freeze is the incident-response kill switch (covers §7 below). No agent-shape introspection (state, memory, gradient, etc.); use the Inspector for that.

See [the inspector-and-operator manual](https://docs.motebit.com/docs/operator/inspector-and-operator) for the full tab guide and operational rhythm.

---

## 7. Monitoring and Rate Limits

### Rate Limiting (per IP, sliding window)

| Tier      | Limit  | Applies To                    |
| --------- | ------ | ----------------------------- |
| auth      | 30/min | Authentication endpoints      |
| read      | 60/min | GET data endpoints            |
| write     | 30/min | POST/PUT/DELETE mutations     |
| public    | 20/min | Unauthenticated endpoints     |
| expensive | 10/min | Graph queries, reconciliation |

WebSocket: 100 messages per 10 seconds per connection.
Federation: 30 requests per minute per peer relay.

### Key Endpoints

```bash
# Health
curl https://relay.motebit.com/health

# Admin state
curl -H "Authorization: Bearer $TOKEN" https://relay.motebit.com/api/v1/admin/state

# Agent discovery
curl -H "Authorization: Bearer $TOKEN" https://relay.motebit.com/api/v1/agents/discover

# Ledger reconciliation
curl -H "Authorization: Bearer $TOKEN" https://relay.motebit.com/api/v1/admin/reconciliation

# Agent balance
curl -H "Authorization: Bearer $TOKEN" https://relay.motebit.com/api/v1/agents/{id}/balance

# Settlements
curl -H "Authorization: Bearer $TOKEN" https://relay.motebit.com/agent/{id}/settlements
```

---

## 7. Emergency Freeze (Kill Switch)

The relay supports runtime freeze mode — all state-mutating operations (POST/PUT/PATCH/DELETE) return 503 while reads remain available. Background loops (settlement retries, heartbeats) are also suspended.

### Activate

Reason is required — rejected without it.

```bash
# Runtime toggle (no restart needed)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"suspected double-credit in settlement pipeline"}' \
  https://relay.motebit.com/api/v1/admin/freeze

# Or via env var (requires restart, reason defaults to "startup")
fly secrets set MOTEBIT_EMERGENCY_FREEZE=true -a motebit-sync
fly machine restart -a motebit-sync
```

### Verify

```bash
curl https://relay.motebit.com/health
# Returns: {"status":"frozen","frozen":true,"timestamp":...}
```

### Resume

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" https://relay.motebit.com/api/v1/admin/unfreeze
```

### What freeze does NOT stop

- GET requests (balances, agent discovery, health, admin state)
- The server process itself (use `fly machine stop` for full shutdown)

### When to freeze

- Suspected economic exploit (double-credit, settlement anomaly)
- Key compromise investigation (stop new receipts while rotating)
- Database investigation (prevent new writes while inspecting state)
- Federation incident (stop accepting forwarded tasks from compromised peer)

### Hard Stop (Out-of-Band Kill)

If the API token is compromised or the freeze endpoint is untrusted:

```bash
fly machine stop -a motebit-sync
```

This immediately halts all traffic and state changes, bypassing application-layer controls entirely. Use when:

- API token compromise suspected
- Freeze endpoint behavior is untrusted
- Active exploit in progress

To restart after investigation:

```bash
fly machine start -a motebit-sync
```

---

## 8. Full System Rehydrate (From Zero)

If all infrastructure is lost (Fly account, volumes, DNS):

### Step 1: Provision Infrastructure

```bash
# Create new Fly apps
fly apps create motebit-sync
fly apps create motebit-web-search
fly apps create motebit-read-url

# Create volumes
fly volumes create motebit_data --size 10 --region sjc -a motebit-sync
fly volumes create web_search_data --size 1 --region sjc -a motebit-web-search
fly volumes create read_url_data --size 1 --region sjc -a motebit-read-url
```

### Step 2: Restore or Bootstrap Database

**If backup exists:**

```bash
# Upload backup to volume
fly ssh sftp shell -a motebit-sync
> put /local/path/motebit-backup.db /data/motebit.db
```

**If no backup (fresh start):**

- Relay auto-creates tables on first boot
- Generates new Ed25519 identity
- Trust graph, settlements, credentials start empty
- Agent identities are client-side — they re-register on reconnect

### Step 3: Set Secrets

```bash
fly secrets set -a motebit-sync \
  MOTEBIT_API_TOKEN=<generate-new> \
  MOTEBIT_RELAY_KEY_PASSPHRASE=<generate-new> \
  X402_PAY_TO_ADDRESS=<usdc-wallet> \
  MOTEBIT_CORS_ORIGIN=<allowed-origins>
```

See SECRETS.md for full inventory.

### Step 4: Deploy

```bash
fly deploy -a motebit-sync --config services/api/fly.toml
fly deploy . -a motebit-web-search --config services/web-search/fly.toml
fly deploy . -a motebit-read-url --config services/read-url/fly.toml
```

### Step 5: Verify Invariants

```bash
# Health check
curl https://relay.motebit.com/health

# Ledger reconciliation
curl -H "Authorization: Bearer $TOKEN" https://relay.motebit.com/api/v1/admin/reconciliation
# Must return: {"consistent":true,"errors":[]}

# Federation identity
curl https://relay.motebit.com/federation/v1/identity
```

### Step 6: Restore DNS

Point `motebit.com` A/AAAA records to new Fly app IPs (via Cloudflare). Update `_motebit.*` TXT records for agent discovery.

### What is lost on fresh start (no backup)

- Relay identity (new keypair — federation peers must re-peer)
- Trust records (agents start at FirstContact)
- Settlement history (economic audit trail)
- Credentials (VCs issued by the relay)
- Virtual account balances (funds in relay_accounts)

### What survives

- Agent identities (client-side keypairs, independent of relay)
- Published npm packages (on npmjs.com)
- Specs and source code (on GitHub)
- Client-side event logs (can re-sync)

---

## 9. Identity Backup & Restore

### Relay Identity

The relay's Ed25519 keypair is the anchor for federation trust, credential issuance, and receipt verification. **If lost, the relay becomes a different entity.**

| Item           | Location                                     | Backup method                            |
| -------------- | -------------------------------------------- | ---------------------------------------- |
| Relay keypair  | `relay_identity` table in `/data/motebit.db` | SQLite `.backup` or Fly volume snapshot  |
| Encryption key | `MOTEBIT_RELAY_KEY_PASSPHRASE` Fly secret    | Store in password manager / secure vault |
| Public key hex | Visible at `/federation/v1/identity`         | Record externally for verification       |

**Backup procedure:**

```bash
# Weekly backup (cron or manual)
fly ssh console -a motebit-sync
sqlite3 /data/motebit.db ".backup /data/motebit-backup-$(date +%Y%m%d).db"
exit
fly ssh sftp get /data/motebit-backup-YYYYMMDD.db -a motebit-sync
# Store in encrypted external backup (S3, GCS, local encrypted drive)
```

**Restore procedure:**

```bash
fly ssh sftp shell -a motebit-sync
> put /local/path/motebit-backup.db /data/motebit.db
fly machine restart -a motebit-sync
```

**If backup is lost:**

- Generate new identity (automatic on boot with empty DB)
- Federation peers must re-peer (they have the old public key pinned)
- Existing credentials issued by the relay become unverifiable (issuer DID changed)
- Trust records from the old relay are orphaned

### Service Agent Identities

| Service    | Key location                     | Backup                        |
| ---------- | -------------------------------- | ----------------------------- |
| web-search | `MOTEBIT_PRIVATE_KEY_HEX` on Fly | Store hex in password manager |
| read-url   | `MOTEBIT_PRIVATE_KEY_HEX` on Fly | Store hex in password manager |

Service agents can be re-created with `npm create motebit`, but they'll have new identities (new keypairs, new motebit_id). Use key rotation (`motebit rotate`) to preserve identity continuity.

---

## 10. Ledger Integrity Checks

The relay runs 5 invariant checks via `GET /api/v1/admin/reconciliation`:

| Check                  | What it validates                                           | Failure means                                      |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Balance equation       | `sum(transactions) == sum(account balances)`                | Money created or destroyed                         |
| No negative balances   | All accounts >= 0                                           | Overdraft (should be impossible with debit guards) |
| Settlement consistency | Every `settled` allocation has a matching settlement record | Settlement recorded without accounting             |
| Withdrawal debits      | Every pending withdrawal has a debit transaction            | Withdrawal approved without funds held             |
| Withdrawal signatures  | Every completed withdrawal has a relay signature            | Withdrawal completed without cryptographic proof   |

**Post-recovery validation:**

```bash
# Run reconciliation
curl -H "Authorization: Bearer $TOKEN" https://relay.motebit.com/api/v1/admin/reconciliation

# Check for stale allocations (locked > 1 hour)
fly ssh console -a motebit-sync
sqlite3 /data/motebit.db "SELECT count(*) FROM relay_allocations WHERE status = 'locked' AND created_at < (strftime('%s','now') * 1000 - 3600000)"

# Verify total system funds
sqlite3 /data/motebit.db "SELECT COALESCE(SUM(balance), 0) FROM relay_accounts"
```

**If reconciliation fails:**

1. Activate emergency freeze immediately
2. Record the error output
3. Investigate the specific check that failed
4. Fix the root cause before unfreezing

---

## 11. Idempotency Guarantees

Which operations are safe to re-run:

| Operation                        | Idempotent? | Guard                                                                                    |
| -------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| Settlement retry loop            | Yes         | `UNIQUE INDEX` on `(task_id, upstream_relay_id)` + receipt timestamp validation          |
| Auto-refund on exhaustion        | Yes         | Allocation status check (`status = 'locked'`) — already-released allocations are skipped |
| Stale allocation cleanup         | Yes         | `status = 'locked' AND created_at < threshold` — already-released are excluded           |
| Task submission                  | No          | Creates new task_id each time                                                            |
| Budget allocation                | Yes         | `INSERT OR IGNORE` on allocation_id                                                      |
| Receipt ingestion                | Yes         | `INSERT OR IGNORE` on settlement_id, dedup on `(task_id, motebit_id)`                    |
| Federation settlement forwarding | Yes         | `UNIQUE INDEX` dedup on `(task_id, upstream_relay_id)`                                   |
| Credit/debit account             | No          | Each call creates a new transaction — do not re-run manually                             |
| Heartbeat loop                   | Yes         | Updates `last_heartbeat_at` and missed count — safe to restart                           |

**Key rule:** Never manually run `creditAccount()` or `debitAccount()` — these are not idempotent. Use the admin reconciliation endpoint to verify state, then fix via the settlement or allocation release flows.

---

## 12. Federation Operations

### Remove a Malicious Peer

```bash
# Via admin API (if peer removal endpoint exists)
# Or directly in the database:
fly ssh console -a motebit-sync
sqlite3 /data/motebit.db "UPDATE relay_peers SET state = 'removed' WHERE peer_relay_id = 'malicious-relay-id'"
```

### Block a Peer

```bash
# Set via env var (takes effect on restart)
fly secrets set MOTEBIT_FEDERATION_BLOCKED_PEERS=malicious-relay-id -a motebit-sync
fly machine restart -a motebit-sync
```

### Inspect Federation Health

```bash
# List all peers with status
curl -H "Authorization: Bearer $TOKEN" https://relay.motebit.com/federation/v1/peers

# Check specific peer's forward success/failure rate
fly ssh console -a motebit-sync
sqlite3 /data/motebit.db "SELECT peer_relay_id, state, successful_forwards, failed_forwards, missed_heartbeats FROM relay_peers"
```

### Disable Federation Entirely

```bash
fly secrets set MOTEBIT_FEDERATION_ENABLED=false -a motebit-sync
fly machine restart -a motebit-sync
```

Discovery returns empty, peering proposals return 403, task forwards return 403. Existing peers remain in DB but are inactive.

---

## 13. Build and Test

```bash
pnpm install              # Install all deps
pnpm run build            # Build all packages (Turborepo)
pnpm run test             # Test all packages
pnpm run typecheck        # Type-check all packages
pnpm run lint             # Lint all packages

# Single package
pnpm --filter @motebit/runtime test
pnpm --filter @motebit/api build
```

Requires: Node >= 20, pnpm 9.15.

### Turbo remote cache

Turbo caches every task's output locally and (when linked) in a shared Vercel Remote Cache. CI restores cached artifacts for packages whose inputs haven't changed since the last green build — typical speedup is 30–50% on a PR touching one package.

**One-time setup (per developer / per CI secret rotation):**

```bash
# 1. Authenticate. Opens a browser; choose the team that should own the cache.
npx turbo login

# 2. Link this repo to the team's cache. Writes .turbo/config.json
#    (which is gitignored — the link is per-checkout).
npx turbo link
```

**GitHub Actions secrets — required for CI to hit the shared cache.** All are optional; Turbo silently falls back to local-cache-only when absent, so CI never hard-fails on missing secrets. But when `TURBO_TEAM` is set to the _wrong_ slug, CI auth fails silently (logs one `Remote caching unavailable` warning, then every task cache-misses), so the runbook here is the authoritative source — **don't copy the slug from memory**, always verify against the Vercel API below.

**Token location (macOS vs Linux):**

```bash
# macOS (current primary dev machine):
cat "$HOME/Library/Application Support/turborepo/config.json"
# { "token": "vcp_xxxx..." }

# Linux (CI runner / secondary dev machines):
cat ~/.config/turborepo/config.json
```

The global config only holds the token. The repo-local `.turbo/config.json` (written by `npx turbo link`) holds the `teamId` — neither file carries the `teamSlug`, which is what `TURBO_TEAM` must be set to.

**Resolve the team slug authoritatively:**

```bash
# Read token + teamId from local config, then ask Vercel for the slug:
TOKEN=$(cat "$HOME/Library/Application Support/turborepo/config.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
TEAM_ID=$(cat .turbo/config.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["teamId"])')
curl -s -H "Authorization: Bearer $TOKEN" "https://api.vercel.com/v2/teams/$TEAM_ID" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("slug:", d["slug"])'
# slug: motebit   ← this is the value TURBO_TEAM must be set to for THIS repo
```

The Vercel team slug for this repo is **`motebit`** (not `hakimlabs` — an earlier version of this runbook had that wrong and sent a principal-engineer audit on a 10-minute detour setting the variable to a non-existent team, which the cache silently accepted then rejected at auth time). If `curl` returns a different slug in the future (team renamed, fresh turbo link), update this doc.

**Set the three Actions values:**

```bash
gh secret set TURBO_TOKEN --body "$TOKEN"                                # from step above
gh variable set TURBO_TEAM --body motebit                                # from `curl | .slug` above
gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY --body "$(openssl rand -hex 32)"
```

**Verify CI is hitting the cache (not silently falling back):**

Look at any CI run's `Build` step log. Healthy output starts with lines like:

```
cache hit, replaying logs 5dbb80b84f320ebc
cache hit, suppressed 96d77d43f1c7ac22
```

Broken output starts with:

```
WARNING  • Remote caching unavailable (Authentication failed — check TURBO_TOKEN or run "turbo login")
cache miss, executing <hash>
```

If every task is `cache miss`, the auth is broken — check that `TURBO_TOKEN` is the current local token (tokens can be rotated on vercel.com) and that `TURBO_TEAM` matches the slug the API returns for your teamId.

`TURBO_REMOTE_CACHE_SIGNATURE_KEY` is optional but recommended — it adds an HMAC over every cache entry so a compromised Vercel bucket can't poison CI with a malicious build output. When set, CI and local both must know it; when absent, cache still works without signature verification.

---

## 14. Architecture Quick Map

```
User devices (desktop/mobile/web/CLI)
  |
  | HTTP + WebSocket (Ed25519 signed JWTs)
  v
Sync Relay (relay.motebit.com)
  |
  | Task routing + budget settlement
  v
Service agents (web-search, read-url, etc.)
  |
  | Federation (relay-to-relay peering)
  v
Peer relays (not yet in production)
```

Identity is Ed25519 keypairs. Relay stores them in SQLite, encrypted at rest with AES-256-GCM when `MOTEBIT_RELAY_KEY_PASSPHRASE` is set. Clients store in OS keyring (desktop/CLI) or expo-secure-store (mobile) or IndexedDB (web).

---

## 15. Incident Response Quick Reference

| Situation               | Action                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| Relay down              | `fly logs -a motebit-sync`, then `fly machine restart -a motebit-sync`                           |
| Service not responding  | `fly logs -a motebit-{service}`, check `/health`, `fly machine restart`                          |
| Database corruption     | Restore from Fly volume snapshot (dashboard) or manual backup                                    |
| npm emergency fix       | Patch, `pnpm changeset`, `pnpm version-packages`, `pnpm run build`, `pnpm release`               |
| Key compromise          | `motebit rotate --reason "compromise"`, update relay identity, succession record revokes old key |
| Fly volume full         | `fly volumes extend {vol_id} --size {new_gb} -a motebit-sync`                                    |
| Rate limited            | Check `fly logs` for 429s, adjust tiers in `services/api/src/index.ts`                           |
| Federation peer failing | Check circuit breaker (>50% failure rate suspends peer automatically)                            |
| Reconciliation failing  | Freeze immediately, record output, investigate, fix before unfreeze                              |
