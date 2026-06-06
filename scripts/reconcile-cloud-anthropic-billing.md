# Reconcile the cloud→Anthropic billing leak

Follow-up to PR #135 (`fix/proxy-anthropic-usage-capture`). Before that fix, the
proxy read top-level `evt.usage` on the Anthropic branch instead of
`message_start.message.usage`, so **every cloud→Anthropic request billed only
`output_tokens`** — `input`, `cacheRead`, and `cacheCreation` were all 0.

## What is and isn't recoverable

The bug dropped input/cache **at capture time**. Both of our own records inherit
the loss:

- `relay_transactions` ("Cloud AI usage" debits) recorded `ceil(outputCost × 1.2)`
  only — it never saw the input cost.
- the `proxy.usage` structured logs logged `input: 0` too.

So the **exact** dollar magnitude is not reconstructable from our DB alone. The
queries below do two things: (1) **size and isolate** the affected requests, and
(2) give a **before/after-deploy marker** to confirm the fix landed. True
magnitude requires the upstream cross-check in step 3.

---

## 1. Ledger — volume, recorded revenue, and the before/after marker

Run against the relay SQLite DB. Debits are stored with a **negative** `amount`
(micro-units); `created_at` is ms-epoch.

```sql
-- Daily cloud-AI billing. avg_micro_per_req is the signal: it should JUMP on the
-- day the fix deploys (input is now billed). The pre-deploy level is the
-- under-billed baseline. NOTE: this conflates OpenAI (correctly billed) and
-- Anthropic (under-billed) — the ledger has no provider column — so the jump is
-- diluted. Use step 2 to isolate Anthropic.
SELECT
  date(created_at / 1000, 'unixepoch')        AS day,
  COUNT(*)                                     AS requests,
  ABS(SUM(amount))                             AS total_micro,
  ROUND(ABS(SUM(amount)) * 1.0 / COUNT(*), 2)  AS avg_micro_per_req
FROM relay_transactions
WHERE type = 'debit'
  AND description = 'Cloud AI usage'
GROUP BY day
ORDER BY day;
```

```sql
-- Per-motebit cloud spend over the affected window (who to potentially correct).
-- Replace the date bounds with [first cloud-Anthropic request .. fix deploy].
SELECT
  motebit_id,
  COUNT(*)          AS requests,
  ABS(SUM(amount))  AS total_micro
FROM relay_transactions
WHERE type = 'debit'
  AND description = 'Cloud AI usage'
  AND created_at >= strftime('%s','2026-05-01') * 1000   -- adjust start
  AND created_at <  strftime('%s','2026-06-06') * 1000   -- = fix deploy date
GROUP BY motebit_id
ORDER BY total_micro DESC;
```

---

## 2. Logs — isolate the affected Anthropic requests (definitive fingerprint)

The `proxy.usage` log line carries `model`, so Anthropic requests are
separable. The bug's fingerprint is **a Claude/Anthropic model with `input == 0`
and `output > 0`**. Run against the proxy log store (Fly logs / aggregator).
Adjust to your query language; logical filter:

```
event = "proxy.usage"
  AND model ~ /claude|anthropic/      -- Anthropic family
  AND input = 0
  AND output > 0
```

- **Count + sum(output)** over the affected window → the precise number of
  under-billed requests and their (billed) output volume.
- **Group by `model` and by `date`** → distribution and trend.
- **After deploy**, the same filter should return ≈ 0. That is the production
  verification that the fix is live (input is now captured, so `input > 0`).

If the log store retains `costMicro`, the under-billed per-request amount ≈ the
true `(input + cacheRead·rate + cacheCreation·1.25)` cost × 1.2 that _should_
have been added — but that true input count was never logged, so it must come
from step 3.

---

## 3. True magnitude — upstream cross-check (treasury-reconciliation pattern)

The only ground truth for historical Anthropic **input** tokens is Anthropic's
own usage/billing export. Mirror the recorded-sum-vs-onchain pattern in
`@motebit/treasury-reconciliation`:

```
A = sum of recorded cloud-Anthropic debits   (step 1/2, our books)
B = Anthropic invoiced cost for the same window × 1.2   (what we SHOULD have billed)
under-billing ≈ B − A
```

Because we bill `ceil(upstreamCost × 1.2)` and the bug billed only the output
slice, for input-heavy requests we likely billed **below upstream cost** — i.e.
lost margin _and_ principal on those requests. If `A < (Anthropic invoice × 1.0)`
for the window, the cloud-Anthropic path ran at a loss.

## 4. Decide

- If the leak is immaterial (likely, pre-scale): record the finding, no
  user-facing correction; the fix stops the bleed going forward.
- If material: use the step-2 per-`motebitId` breakdown to scope any correction.

Verify the fix is live by re-running step 2 post-deploy and confirming the
`input = 0` Anthropic cohort drops to ≈ 0.
