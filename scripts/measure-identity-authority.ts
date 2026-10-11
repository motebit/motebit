/**
 * measure-identity-authority — how much identity authority on a live relay
 * was possibly written by a party that never proved the identity's current
 * key? (docs/design/identity-authority-writers.md §6, queries Q1–Q6)
 *
 * The relay computes the census itself (`measureIdentityAuthority`,
 * services/relay/src/identity-authority-census.ts) and serves it on the
 * master-token `GET /api/v1/admin/identity-authority/census`, because
 * production allows no direct database read. This script only fetches and
 * prints it. Counts, ids and buckets only — the route serves no key, token,
 * address or signature. Every flagged row carries one bucket:
 * `definitely_invalid` (the only one that could ever become eligible for
 * automatic cleanup — none exists), `suspicious` (human review) or
 * `legitimate_legacy`. The census runs on a handle the database itself keeps
 * read-only (`PRAGMA query_only`).
 *
 *   RELAY_URL=https://motebit-sync-stg.fly.dev AUTH_TOKEN=… \
 *     npx tsx scripts/measure-identity-authority.ts [--limit 50] [--json]
 *
 * Read-only. The default RELAY_URL is staging; running it against
 * production is an operator decision, never this script's default. Exits 1
 * when the relay does not answer or the token is refused — "unknown" is not
 * a count.
 */

const RELAY_URL = (process.env["RELAY_URL"] ?? "https://motebit-sync-stg.fly.dev").replace(
  /\/+$/,
  "",
);
const AUTH_TOKEN = process.env["AUTH_TOKEN"] ?? "";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** One bucket per flagged row or id (docs/design/identity-authority-writers.md §6). */
interface Buckets {
  definitely_invalid: number;
  suspicious: number;
  legitimate_legacy: number;
}
interface Counted {
  count: number;
  buckets: Buckets;
}

interface Census {
  q1_planted_device_rows: Counted & { count_no_current_key: number };
  q2_sovereign_squats: Counted;
  q3_unbound_money_destinations: {
    settlement_address: Counted;
    pay_to_address: Counted;
    withdrawal_destination: Counted;
  };
  q4_unproven_guardians: { identity_keys: Counted; agent_registry: Counted };
  q5_keyless_with_device_rows: Counted;
  q6_v1_peers: Counted & { by_state: Record<string, number> };
}

/** `invalid/suspicious/legacy` — only `invalid` could ever be cleaned up automatically. */
const b = (c: Counted): string =>
  `[invalid ${c.buckets.definitely_invalid} / suspicious ${c.buckets.suspicious} / legacy ${c.buckets.legitimate_legacy}]`;

async function main(): Promise<void> {
  const limit = arg("--limit");
  const url = `${RELAY_URL}/api/v1/admin/identity-authority/census${limit !== undefined ? `?limit=${encodeURIComponent(limit)}` : ""}`;
  console.log(`▸ measure-identity-authority — ${url}`);
  if (AUTH_TOKEN === "") {
    console.error("measure-identity-authority: AUTH_TOKEN is not set.");
    console.error(
      "Fix: export AUTH_TOKEN=<the relay's operator master token>; the census lives in services/relay/src/identity-authority-census.ts.",
    );
    process.exit(1);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error(
      `measure-identity-authority: relay unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`measure-identity-authority: HTTP ${res.status} from ${RELAY_URL}.`);
    console.error(
      "Fix: 401 means the token is not this relay's operator token; 404 means the relay predates Inc 1 of docs/design/identity-authority-writers.md (deploy the branch first).",
    );
    process.exit(1);
  }
  const body = (await res.json()) as Census;
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const q3 = body.q3_unbound_money_destinations;
  console.log(
    `  Q1 device rows not on the current key:        ${body.q1_planted_device_rows.count} ${b(body.q1_planted_device_rows)} (${body.q1_planted_device_rows.count_no_current_key} of identities with no current key)`,
  );
  console.log(
    `  Q2 sovereign-id squats:                       ${body.q2_sovereign_squats.count} ${b(body.q2_sovereign_squats)}`,
  );
  console.log(
    `  Q3 unbound money destinations:                settlement ${q3.settlement_address.count} ${b(q3.settlement_address)}, pay-to ${q3.pay_to_address.count} ${b(q3.pay_to_address)}, withdrawals (90d) ${q3.withdrawal_destination.count} ${b(q3.withdrawal_destination)}`,
  );
  console.log(
    `  Q4 guardians without provenance:              identity_keys ${body.q4_unproven_guardians.identity_keys.count} ${b(body.q4_unproven_guardians.identity_keys)}, agent_registry ${body.q4_unproven_guardians.agent_registry.count} ${b(body.q4_unproven_guardians.agent_registry)}`,
  );
  console.log(
    `  Q5 keyless ids with keyed device rows:        ${body.q5_keyless_with_device_rows.count} ${b(body.q5_keyless_with_device_rows)}`,
  );
  console.log(
    `  Q6 peers with no v2 federation evidence:      ${body.q6_v1_peers.count} ${b(body.q6_v1_peers)} ${JSON.stringify(body.q6_v1_peers.by_state)}`,
  );
  console.log("✓ measure-identity-authority: 6 queries answered. Re-run with --json for the ids.");
}

main().catch((err: unknown) => {
  console.error(`measure-identity-authority: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
