# Runbook — the first metered dollar

The first autonomous payment executed under a standing grant's signed ceiling:
grant → due tick → `delegate_to_agent` → quote metered at the rail → atomic
Solana USDC settlement → relay-recorded p2p row. Written 2026-07-05; **executed
live 2026-07-07** — tx `2RJg2Yzj4Xwqb5vtuDeBhTykxMUDETY9nyinp8rP1uhwS8dZpgsij8sng4fARAWcQdMF9HfLJXswwBHmpRfHbaNS`
(worker +$0.050000, treasury fee +$0.002632, atomic), refusal half proven the
same tick. Everything below is the post-execution path as `motebit@1.8.0`
ships it.

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

1. **Install the CLI**: `npm i -g motebit` (≥ 1.8.0 — the metering chain,
   grant pre-flight, and wallet homeostasis all ship in the published bundle).
   Optionally prove the binary itself: `motebit verify-release` checks the
   installed bundle's bytes against the relay's signed release witness.
2. **Governance posture.** The `balanced` preset hard-denies R4 money — the
   grant never overrides a hard ceiling (by design; proven live when the
   first ceremony stalled on exactly this). Permit governed money
   deliberately: set `"governance": {"approvalPreset": "autonomous"}` in
   `~/.motebit/config.json`.
3. **Register**: `motebit register` (defaults to the production relay and
   saves `sync_url`). This also **pins the relay operator's key** from its
   signed transparency declaration — the trust root the P2P treasury address
   derives from. Watch for the `Pinned relay key …` line.
4. **Fund the sovereign wallet.** `motebit wallet` prints the identity-derived
   Solana address, balance, and its own funding posture. Send **≥ $1 USDC on
   the SOLANA network + ~0.005 SOL** (tx fees) — or send SOL from anywhere
   and normalize it yourself: `motebit wallet swap 0.02` converts SOL → USDC
   working capital (gas floor enforced). $1 covers ~19 tasks at the worker's
   price.
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
   **The pre-flight prints at launch**: one `[grant armed — …]` line means the
   whole chain (grant → tick → governance → rail → pin → capital) is ready;
   any blocker prints with its exact remedy. Then ask, in the REPL:
   _"Delegate a web search about <topic> to another agent."_ No approval
   prompt appears: the verified in-scope grant IS the R4 authorizer
   (policy-gate 8c), bounded by everything the ceiling signed.

## What executes (the chain you are watching)

the verified in-scope grant extends the tool offering to R4 and satisfies the
approval band (gate 8c; 8b still re-raises any grantless R4) → loop admits the
late-bound tool (grant + meter present) → discovery finds the worker → quote resolves
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
- **The refusals are the proof** (proven live 2026-07-07: meter row and
  on-chain balance byte-identical after the refusal). Ask for a second
  delegation in the same hour: the meter replays the nonce and refuses
  before broadcast — the model surfaces it as a payment-authorization wall,
  and the owner surface renders the typed `AuthorityDelta` repair. Run
  `mb grant revoke <id>`: the next tick is refused locally AND the relay
  fence 403s the submission — watch both.

## Blast radius, stated honestly

Worst case if everything above misbehaves at once: the grant's signed
lifetime ($1) leaves the wallet to a worker we operate, over 7 days, one
payment per hour, revocable at any moment with immediate local effect. The
wallet holds only what step 4 funded.
