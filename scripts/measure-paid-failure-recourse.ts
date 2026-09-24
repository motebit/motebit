#!/usr/bin/env tsx
/**
 * measure-paid-failure-recourse — is the escrow trigger firing?
 *
 * `docs/doctrine/paid-failure-recourse.md` settles #610 against building escrow,
 * on measurement rather than principle: every paid failure observed on
 * 2026-09-02 was a worker that could never have done the work at all (provider
 * credit exhausted), and that class is now structurally prevented by the
 * readiness gate rather than compensated afterwards.
 *
 * A decision made from a snapshot has to be re-checkable, or it becomes an
 * assertion that quietly rots — the exact failure the coverage-graduation
 * post-mortem describes, where five stale entries tracked gaps that had already
 * closed and nobody re-measured until the deadline. So the trigger is a script,
 * not a sentence.
 *
 * THE TRIGGER: a paid task that failed for a reason the readiness gate could NOT
 * have prevented.
 *
 * It is computed with `classifyProviderFailure` — the SAME function the readiness
 * gate uses to decide whether to stop advertising. That is the point. The set of
 * failures readiness prevents and the set this trigger ignores are one set by
 * construction, so the two can never drift into disagreeing. Two prose
 * descriptions that agree today would not survive a year.
 *
 * A report, never a gate: it needs the network and a bearer token, so it has no
 * business in `pnpm check`. Exit is 0 unless `--fail-on-trigger` is passed (for
 * scheduled use, where a fired trigger should be loud).
 *
 * Usage:
 *   RELAY_URL=… AUTH_TOKEN=… npx tsx scripts/measure-paid-failure-recourse.ts
 *   … --fail-on-trigger        # exit 1 when the un-preventable class is non-empty
 *   … --limit 500              # receipts sampled per agent (default 200)
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyProviderFailure } from "../packages/molecule-runner/src/readiness.js";

const RELAY_URL = process.env["RELAY_URL"] ?? "https://motebit-sync-stg.fly.dev";
const AUTH_TOKEN = process.env["AUTH_TOKEN"] ?? "";
const FAIL_ON_TRIGGER = process.argv.includes("--fail-on-trigger");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
})();

const authHeaders: Record<string, string> = AUTH_TOKEN
  ? { Authorization: `Bearer ${AUTH_TOKEN}` }
  : {};

interface WireAgent {
  motebit_id: string;
  display_name?: string | null;
  pricing?: Array<{ unit_cost: number }> | null;
}

interface ReceiptRow {
  task_id: string;
  status: string;
  receipt_json: string;
}

async function discover(): Promise<WireAgent[]> {
  const res = await fetch(`${RELAY_URL}/api/v1/agents/discover`, { headers: authHeaders });
  if (!res.ok) throw new Error(`discover returned ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { agents?: WireAgent[] };
  return data.agents ?? [];
}

async function receipts(motebitId: string): Promise<ReceiptRow[]> {
  const res = await fetch(`${RELAY_URL}/api/v1/agents/${motebitId}/receipts?limit=${LIMIT}`, {
    headers: authHeaders,
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { receipts?: ReceiptRow[] };
  return data.receipts ?? [];
}

export interface Failure {
  agent: string;
  taskId: string;
  /** The durable reason `classifyProviderFailure` recognized, or null. */
  durable: string | null;
  message: string;
}

export interface RecourseSplit {
  /** Failures the readiness gate now stops BEFORE the sale. */
  preventable: Failure[];
  /** Failures readiness could not have prevented — the buyer paid for real work. */
  triggering: Failure[];
}

/**
 * The split that decides the question, as a pure function so it can be tested
 * without a relay or a token.
 *
 * `classifyProviderFailure` is the SAME function the readiness gate consults, so
 * "preventable" here means exactly "readiness would have withheld the heartbeat
 * for this" — one definition, not two prose descriptions that agree today.
 */
export function splitByRecourse(failures: readonly Failure[]): RecourseSplit {
  return {
    preventable: failures.filter((f) => f.durable != null),
    triggering: failures.filter((f) => f.durable == null),
  };
}

/** Classify one failure message into the `Failure` shape. */
export function toFailure(agent: string, taskId: string, message: string): Failure {
  return { agent, taskId, durable: classifyProviderFailure(message), message };
}

async function main(): Promise<void> {
  console.log(`measure-paid-failure-recourse — relay=${RELAY_URL} limit=${LIMIT}/agent\n`);

  const agents = await discover();
  // A worker with no listed price cannot produce a PAID failure, and an unpaid
  // failure costs the delegator nothing — it is outside this question entirely.
  const priced = agents.filter((a) => (a.pricing ?? []).some((p) => p.unit_cost > 0));
  console.log(`${agents.length} agent(s) discovered, ${priced.length} priced\n`);

  let sampled = 0;
  let completed = 0;
  const failures: Failure[] = [];

  for (const agent of priced) {
    const rows = await receipts(agent.motebit_id);
    if (rows.length === 0) continue;
    const name = agent.display_name ?? agent.motebit_id.slice(0, 8);
    const failed = rows.filter((r) => r.status === "failed");
    sampled += rows.length;
    completed += rows.filter((r) => r.status === "completed").length;

    for (const row of failed) {
      let message = "";
      try {
        message = String((JSON.parse(row.receipt_json) as { result?: unknown }).result ?? "");
      } catch {
        message = "(unparseable receipt_json)";
      }
      failures.push(toFailure(name, row.task_id, message));
    }

    console.log(
      `  ${name.padEnd(24)} ${String(rows.length).padStart(4)} receipt(s), ${failed.length} failed`,
    );
  }

  // Measured nothing? Say so and stop. Printing "trigger not fired" above this
  // would be the same shape of lie the readiness arc and #568 both turned on:
  // an absent denominator reading as a clean result. A reader who stops at the
  // first conclusion must not be able to come away reassured.
  if (sampled === 0) {
    console.log(
      `\nMEASURED NOTHING — zero paid receipts sampled. This is NOT the same as\n` +
        `measuring zero failures, and NO conclusion about the trigger follows from it.\n\n` +
        `  The receipts endpoint requires a bearer token: set AUTH_TOKEN (and\n` +
        `  RELAY_URL if not staging) and run again.`,
    );
    process.exit(FAIL_ON_TRIGGER ? 1 : 0);
  }

  const { preventable, triggering: triggered } = splitByRecourse(failures);

  const pct = (n: number): string => (sampled > 0 ? `${((n / sampled) * 100).toFixed(1)}%` : "n/a");

  console.log(
    `\n${sampled} paid receipt(s) sampled — ${completed} completed, ${failures.length} failed (${pct(failures.length)})`,
  );
  console.log(
    `  ${preventable.length} PREVENTABLE — a durable provider condition the readiness gate now stops before the sale`,
  );
  console.log(
    `  ${triggered.length} TRIGGERING  — a failure readiness could not have prevented; the buyer paid for real attempted work`,
  );

  if (preventable.length > 0) {
    const byReason = new Map<string, number>();
    for (const f of preventable) byReason.set(f.durable!, (byReason.get(f.durable!) ?? 0) + 1);
    console.log("\n  preventable, by reason:");
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)} × ${reason}`);
    }
  }

  if (triggered.length > 0) {
    console.log("\n  TRIGGERING failures (the class escrow exists for):");
    for (const f of triggered.slice(0, 20)) {
      console.log(`    ${f.agent} ${f.taskId.slice(0, 8)} — ${f.message.slice(0, 100)}`);
    }
    if (triggered.length > 20) console.log(`    … and ${triggered.length - 20} more`);
    console.log(
      `\n  → The trigger in docs/doctrine/paid-failure-recourse.md has FIRED.\n` +
        `    Re-open the recourse question in this order: (1) voluntary refund as a\n` +
        `    signed act, (2) bond recourse + reservation ledger, (3) on-chain escrow.\n` +
        `    Do not jump to escrow — it is the most expensive step and the least\n` +
        `    motebit-native. Read the doctrine before acting on this number.`,
    );
  } else {
    console.log(
      `\n  → Trigger NOT fired. Every paid failure sampled was preventable-before-the-sale,\n` +
        `    which is what the readiness gate now does. The decision to refuse escrow\n` +
        `    still holds on this evidence.`,
    );
  }

  if (FAIL_ON_TRIGGER && triggered.length > 0) process.exit(1);
}

// Entrypoint guard: importing this module (the test does) must stay inert.
const invokedDirectly =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
