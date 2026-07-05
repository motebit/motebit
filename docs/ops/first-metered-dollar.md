# Runbook — the first metered dollar

The first autonomous payment executed under a standing grant's signed ceiling:
grant → due tick → `delegate_to_agent` → quote metered at the rail → atomic
Solana USDC settlement → relay-recorded p2p row. Written 2026-07-05, every
precondition below verified live that day.

## Preconditions (verified)

- **Relay** (`https://relay.motebit.com`): healthy, running the delegation-
  revocation cache + acceptance-time fence (`GET /api/v1/delegations/revocations`
  answers; migration 39 applied). `SOLANA_RPC_URL` set → p2p-verifier live.
- **Worker**: `motebit-web-search-019d6828` (one of our own services) is awake,
  advertises `web_search`/`read_url` at **$0.05/request**, `settlement_modes:
relay,p2p`, Solana settlement address published. The quote the meter will see:
  $0.05 net + 5% fee ≈ **$0.0527 gross** per task.
- **Machinery**: the late-bound metering chain (PR #263) — loop admission on
  grant+meter presence, `wrapP2pPaymentWithMeter` refusing any over-ceiling
  broadcast, `grant_id` on the submission body engaging the relay fence.

## Operator steps (founder's terminal — passphrase prompts throughout)

1. **CLI with the metering chain.** Until `motebit@1.8+` is on npm, run the
   repo build: `pnpm --filter motebit build` then alias
   `alias mb='node <repo>/apps/cli/dist/index.js'`.
2. **Point at the relay.** Add `"sync_url": "https://relay.motebit.com"` to
   `~/.motebit/config.json` (or `export MOTEBIT_SYNC_URL=...`).
3. **Register** the identity + device with the relay: `mb register`.
   (Signed task submission verifies against the relay's device store.)
4. **Fund the sovereign wallet.** `mb wallet` prints the identity-derived
   Solana address and USDC balance. Send **≥ $1 USDC + ~0.005 SOL** (tx fees)
   to it from the treasury Ledger. $1 covers ~19 tasks at the worker's price.
5. **Mint the delegation grant** (the ceremony's successor to grant
   `019f3415…`, whose `pay_invoice` scope deliberately does not cover
   delegation — scope is a signed ceiling, so a new authority is a new grant):

   ```
   mb grant create --scope delegate_to_agent --subject "research:delegated-web-search" \
     --lifetime-usd 1 --days 7 --cadence-hours 1
   ```

   `--cadence-hours 1` pre-mints 168 hourly ticks; **one tick meters exactly
   one payment** (the signed nonce), so this shape allows at most one paid
   delegation per hour, ≤ $1 total, for 7 days. Tighter is fine.

6. **Run it:**

   ```
   mb --grant <grant_id> --pay-new-agents
   ```

   `--pay-new-agents` is the cold-start acknowledgment — there is no trust
   history with the worker yet, and P2P eligibility fail-closes without it.
   Then ask, in the REPL: _"Delegate a web search about <topic> to another
   agent."_

## What executes (the chain you are watching)

gate 8b auto-clears R4 under the verified grant → loop admits the late-bound
tool (grant + meter present) → discovery finds the worker → quote resolves
($0.05 + fee) → **`wrapP2pPaymentWithMeter` meters the gross against the $1
lifetime with the tick's signed nonce** → atomic multi-output Solana USDC tx
(worker leg + treasury fee leg) → submission carries `grant_id` (relay fence
checks the revocation cache before any hold) → worker executes, returns a
signed receipt → trust bumps → relay records the `settlement_mode='p2p'` row
→ the p2p-verifier confirms both legs onchain.

## Verify afterward

- The tx on Solana explorer (the REPL surfaces the hash).
- The relay row: `GET /agent/<worker_id>/settlements` (or admin dashboard).
- The receipt: `mb ledger` / receipt.computer.
- The accumulator: `sqlite3 ~/.motebit/motebit.db "select * from grant_spend_state;"`
  — lifetime_spent_micro should read the gross, high_water_nonce the tick's
  issued_at.
- **The refusals are the proof.** Ask for a second delegation in the same
  hour: the meter replays the nonce and refuses before broadcast. Run
  `mb grant revoke <id>`: the next tick is refused locally AND the relay
  fence 403s the submission — watch both.

## Blast radius, stated honestly

Worst case if everything above misbehaves at once: the grant's signed
lifetime ($1) leaves the wallet to a worker we operate, over 7 days, one
payment per hour, revocable at any moment with immediate local effect. The
wallet holds only what step 4 funded.
