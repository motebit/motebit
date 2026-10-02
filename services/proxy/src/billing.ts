/**
 * Motebit-cloud billing — the proxy → relay debit, made provable.
 *
 * The relay is the ledger of record: a served motebit-cloud turn is billed only
 * when the relay records a `fee` row (`POST /api/v1/agents/:id/debit`,
 * authenticated by the shared `x-relay-secret`). Two rules make that provable:
 *
 *   1. **Fail closed on configuration.** `resolveBillingConfig` is checked at
 *      ADMISSION. With no `RELAY_PROXY_SECRET` or no `RELAY_API_URL` the proxy
 *      refuses motebit-cloud instead of serving turns whose debit cannot land.
 *      There is no default relay URL: a default hides a missing variable.
 *   2. **Every attempt ends in exactly one structured event.** `debitRelay` is
 *      the only exported way to debit; it wraps `attemptDebit` (which returns a
 *      typed `DebitOutcome` and may not throw past its own catch) and ALWAYS
 *      emits `proxy.debit_landed` or `proxy.debit_failed`. There is no early
 *      return around the emitter, so a dropped debit is always countable from
 *      logs. Secrets never appear in an event.
 */

export interface BillingConfig {
  relayUrl: string;
  secret: string;
}

export type BillingConfigResult =
  | { ok: true; config: BillingConfig }
  | { ok: false; missing: Array<"RELAY_API_URL" | "RELAY_PROXY_SECRET"> };

export function resolveBillingConfig(
  env: Record<string, string | undefined> = process.env,
): BillingConfigResult {
  const missing: Array<"RELAY_API_URL" | "RELAY_PROXY_SECRET"> = [];
  const rawUrl = env.RELAY_API_URL?.trim() ?? "";
  let relayUrl = "";
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    relayUrl = rawUrl.replace(/\/+$/, "");
  } catch {
    missing.push("RELAY_API_URL");
  }
  const secret = env.RELAY_PROXY_SECRET ?? "";
  if (secret.trim() === "") missing.push("RELAY_PROXY_SECRET");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { relayUrl, secret } };
}

/** @internal — exported only for unit tests. */
export const DEBIT_MAX_ATTEMPTS = 3;
/** Per-attempt bound so a hung relay cannot hold the client's stream open. */
const DEBIT_ATTEMPT_TIMEOUT_MS = 5_000;

export type DebitFailureReason =
  /** RELAY_API_URL / RELAY_PROXY_SECRET missing at debit time. */
  | "not_configured"
  /** Metered cost is not a positive integer — a served turn with no billable usage. */
  | "no_billable_amount"
  /** Relay answered 401/403: secret mismatch, or RELAY_PROXY_SECRET unset at the relay. */
  | "unauthorized"
  /** Relay answered another 4xx (malformed body, unknown route). */
  | "rejected"
  /** Relay answered 2xx with `success: false`: nothing spendable to debit. */
  | "insufficient_balance"
  /** Relay answered 2xx with a body that is not the debit contract. */
  | "bad_response"
  /** 5xx on every attempt. */
  | "relay_error"
  /** Network error / timeout on every attempt. */
  | "unreachable";

export type DebitOutcome =
  | {
      landed: true;
      attempts: number;
      balanceAfterMicro: number | null;
      idempotent: boolean;
      /** Part of the metered cost the relay could not debit (balance drained to zero). */
      shortfallMicro: number;
    }
  | {
      landed: false;
      attempts: number;
      reason: DebitFailureReason;
      status?: number;
      error?: string;
      missing?: string[];
    };

async function attemptDebit(
  motebitId: string,
  amountMicro: number,
  referenceId: string,
): Promise<DebitOutcome> {
  const cfg = resolveBillingConfig();
  if (!cfg.ok)
    return { landed: false, attempts: 0, reason: "not_configured", missing: cfg.missing };
  if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) {
    return { landed: false, attempts: 0, reason: "no_billable_amount" };
  }
  const { relayUrl, secret } = cfg.config;
  const url = `${relayUrl}/api/v1/agents/${encodeURIComponent(motebitId)}/debit`;

  let last: DebitOutcome = { landed: false, attempts: 0, reason: "unreachable" };
  for (let attempt = 1; attempt <= DEBIT_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-relay-secret": secret },
        body: JSON.stringify({
          amount: amountMicro,
          reference_id: referenceId,
          description: "Cloud AI usage",
        }),
        signal: AbortSignal.timeout(DEBIT_ATTEMPT_TIMEOUT_MS),
      });
      if (res.ok) {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const b = body as {
          success?: unknown;
          balance?: unknown;
          idempotent?: unknown;
          shortfall?: unknown;
        } | null;
        if (b?.success === true) {
          return {
            landed: true,
            attempts: attempt,
            balanceAfterMicro: typeof b.balance === "number" ? b.balance : null,
            idempotent: b.idempotent === true,
            shortfallMicro: typeof b.shortfall === "number" && b.shortfall > 0 ? b.shortfall : 0,
          };
        }
        if (b?.success === false) {
          return {
            landed: false,
            attempts: attempt,
            reason: "insufficient_balance",
            status: res.status,
          };
        }
        return { landed: false, attempts: attempt, reason: "bad_response", status: res.status };
      }
      if (res.status === 401 || res.status === 403) {
        return { landed: false, attempts: attempt, reason: "unauthorized", status: res.status };
      }
      // Other 4xx won't change on retry (malformed amount, unknown route).
      if (res.status >= 400 && res.status < 500) {
        return { landed: false, attempts: attempt, reason: "rejected", status: res.status };
      }
      last = { landed: false, attempts: attempt, reason: "relay_error", status: res.status };
    } catch (err) {
      last = {
        landed: false,
        attempts: attempt,
        reason: "unreachable",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    // The relay is idempotent on reference_id, so a retry after a lost 200
    // cannot double-charge.
    if (attempt < DEBIT_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  return last;
}

/**
 * Debit the relay for a served turn's metered cost. Never throws; ALWAYS emits
 * exactly one structured event (`proxy.debit_landed` / `proxy.debit_failed`)
 * and returns the outcome. `proxy.debit_failed` is the reconciliation trail
 * for revenue the relay never recorded; a landed debit with a non-zero
 * `shortfallMicro` is logged at error level too (served beyond the balance).
 */
export async function debitRelay(
  motebitId: string,
  amountMicro: number,
  referenceId: string,
): Promise<DebitOutcome> {
  let outcome: DebitOutcome;
  try {
    outcome = await attemptDebit(motebitId, amountMicro, referenceId);
  } catch (err) {
    outcome = {
      landed: false,
      attempts: 0,
      reason: "unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  emitDebitOutcome(outcome, { requestId: referenceId, motebitId, amountMicro });
  return outcome;
}

function emitDebitOutcome(
  outcome: DebitOutcome,
  ctx: { requestId: string; motebitId: string; amountMicro: number },
): void {
  if (outcome.landed) {
    const line = JSON.stringify({ event: "proxy.debit_landed", ...ctx, ...outcome });
    if (outcome.shortfallMicro > 0) console.error(line);
    else console.log(line);
    return;
  }
  console.error(JSON.stringify({ event: "proxy.debit_failed", ...ctx, ...outcome }));
}
