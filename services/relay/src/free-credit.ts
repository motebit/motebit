/**
 * Free "first taste" of cloud inference — the activation unlock.
 *
 * A brand-new motebit has no provider, so its first message hits a setup wall
 * (pay / bring an API key / download a model). That wall is where most new
 * users bounce. This grants a small one-time free balance so a fresh motebit
 * can just talk on motebit cloud, then meets the normal upgrade prompt when the
 * credit runs out. It reuses the entire existing economic loop — the grant is
 * recorded as a `deposit` with a distinctive `free-credit:<motebit_id>` ledger
 * reference, so the proxy-token / balance / debit / 402 / upgrade path already
 * handles everything downstream. (Activates the dormant free-tier scaffolding in
 * services/proxy — see `FREE_MODEL_ALLOWLIST` there.)
 *
 * SPEND IS OFF BY DEFAULT. The feature is inert unless the operator sets
 * `MOTEBIT_FREE_CREDIT_USD` > 0 — the code ships complete, but grants nothing
 * (and costs nothing) until a budget is configured. Three caps bound exposure:
 *   1. one-time per motebit (idempotent on the `free-credit:<id>` reference),
 *   2. per-IP per day (`MOTEBIT_FREE_CREDIT_IP_DAILY_CAP`, default 10) — minting
 *      a fresh motebit is free, so the per-motebit grant alone is sybil-drainable;
 *      this is the casual-abuse cap,
 *   3. a global daily budget (`MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD`, default 25)
 *      — the hard backstop on total give-away per day regardless of IP rotation.
 *
 * Best-effort: any failure returns "not granted" and never breaks token issuance.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { getOrCreateAccount, creditAccount, toMicro } from "./accounts.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "free-credit" });

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FreeCreditConfig {
  /** Amount granted per new motebit, in micro-units. 0 ⇒ feature off. */
  amountMicro: number;
  /** Max grants per source IP per day. */
  ipDailyCap: number;
  /** Hard global cap on total free credit granted per day, in micro-units. */
  dailyBudgetMicro: number;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Read the free-credit config from env. Defaults keep the feature OFF (amount 0). */
export function freeCreditConfigFromEnv(): FreeCreditConfig {
  return {
    amountMicro: toMicro(envNum("MOTEBIT_FREE_CREDIT_USD", 0)),
    ipDailyCap: Math.floor(envNum("MOTEBIT_FREE_CREDIT_IP_DAILY_CAP", 10)),
    dailyBudgetMicro: toMicro(envNum("MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD", 25)),
  };
}

export type FreeCreditResult =
  | { granted: true; amountMicro: number }
  | {
      granted: false;
      reason: "disabled" | "already_granted" | "ip_cap" | "daily_budget" | "error";
    };

/** UTC day key (YYYY-MM-DD) for the per-IP daily counter + budget window. */
function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Grant the one-time free credit to `motebitId` if eligible. Idempotent: a
 * motebit that already received it (or any failure / cap hit) is a no-op.
 * Returns whether it granted, for logging — callers ignore it and just re-read
 * the balance afterward.
 */
export function grantFreeCreditIfEligible(
  db: DatabaseDriver,
  motebitId: string,
  ip: string,
  opts?: { config?: FreeCreditConfig; nowMs?: number },
): FreeCreditResult {
  const cfg = opts?.config ?? freeCreditConfigFromEnv();
  const nowMs = opts?.nowMs ?? Date.now();

  if (cfg.amountMicro <= 0) return { granted: false, reason: "disabled" };

  try {
    const ref = `free-credit:${motebitId}`;

    // 1. One-time per motebit — the grant reference is unique per identity.
    const existing = db
      .prepare("SELECT 1 AS n FROM relay_transactions WHERE reference_id = ? LIMIT 1")
      .get(ref) as { n: number } | undefined;
    if (existing) return { granted: false, reason: "already_granted" };

    const dayStart = nowMs - (nowMs % DAY_MS);
    const day = dayKey(nowMs);

    // 2. Global daily budget — sum of today's free-credit grants.
    const spentRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS spent FROM relay_transactions
         WHERE reference_id LIKE 'free-credit:%' AND created_at >= ?`,
      )
      .get(dayStart) as { spent: number } | undefined;
    const spent = spentRow?.spent ?? 0;
    if (spent + cfg.amountMicro > cfg.dailyBudgetMicro) {
      logger.warn("free-credit.daily_budget_reached", { spent, day });
      return { granted: false, reason: "daily_budget" };
    }

    // 3. Per-IP daily cap.
    const ipRow = db
      .prepare("SELECT count FROM relay_free_grants WHERE ip = ? AND day = ?")
      .get(ip, day) as { count: number } | undefined;
    if ((ipRow?.count ?? 0) >= cfg.ipDailyCap) {
      return { granted: false, reason: "ip_cap" };
    }

    // Grant: credit the account, then bump the per-IP counter.
    getOrCreateAccount(db, motebitId);
    creditAccount(
      db,
      motebitId,
      cfg.amountMicro,
      "deposit",
      ref,
      "Welcome credit — free first taste of motebit cloud",
    );
    db.prepare(
      `INSERT INTO relay_free_grants (ip, day, count) VALUES (?, ?, 1)
       ON CONFLICT(ip, day) DO UPDATE SET count = count + 1`,
    ).run(ip, day);

    logger.info("free-credit.granted", { motebitId, amountMicro: cfg.amountMicro, ip, day });
    return { granted: true, amountMicro: cfg.amountMicro };
  } catch (err) {
    logger.warn("free-credit.error", {
      motebitId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { granted: false, reason: "error" };
  }
}
