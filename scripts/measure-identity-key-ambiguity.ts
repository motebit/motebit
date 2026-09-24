/**
 * measure-identity-key-ambiguity — how many identities can this relay NOT
 * name a key for without guessing? (#703, identity-key-state-v1 §5 / §10 Q3)
 *
 * Increment 2 backfills `identity_keys` from the registry, the succession
 * chain, and device rows ONLY where every keyed device row of an identity
 * agrees (D5: a wrong key served from a foundation-law route is a planted
 * binding; not knowing is honest, guessing is not). The rest are filled on
 * their next bootstrap or register. This is the number the backfill's PR
 * promises against, read from the live relay BEFORE the backfill is
 * written — and again after, and again whenever the operator looks: the
 * relay computes it in `aggregateHealthSummary` (health-summary.ts) and
 * serves it on `/api/v1/admin/health`, so the same query answers every
 * time and a direct database read (which production does not allow) is
 * never needed.
 *
 *   RELAY_URL=https://relay.motebit.com AUTH_TOKEN=… \
 *     npx tsx scripts/measure-identity-key-ambiguity.ts
 *
 * Read-only. Exits 1 when the relay does not answer or the token is
 * refused — "unknown" is not a count.
 */

const RELAY_URL = (process.env["RELAY_URL"] ?? "https://motebit-sync-stg.fly.dev").replace(
  /\/+$/,
  "",
);
const AUTH_TOKEN = process.env["AUTH_TOKEN"] ?? "";

interface Population {
  identity_keys_total: number;
  identity_keys_unambiguous: number;
  identity_keys_ambiguous: number;
  identity_keys_keyless: number;
  total_registered: number;
  total_known: number;
}

async function main(): Promise<void> {
  console.log(`▸ measure-identity-key-ambiguity — ${RELAY_URL}/api/v1/admin/health`);
  if (AUTH_TOKEN === "") {
    console.error("measure-identity-key-ambiguity: AUTH_TOKEN is not set.");
    console.error(
      "Fix: export AUTH_TOKEN=<the relay's operator master token> (the same bearer the operator console uses for /api/v1/admin/*); the metric lives in services/relay/src/health-summary.ts `identityKeyPopulation`.",
    );
    process.exit(1);
  }
  let res: Response;
  try {
    res = await fetch(`${RELAY_URL}/api/v1/admin/health`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(
      `measure-identity-key-ambiguity: relay unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`measure-identity-key-ambiguity: HTTP ${res.status} from ${RELAY_URL}.`);
    console.error(
      "Fix: 401/403 means the token is not this relay's operator token; 404 means the relay predates #744 (deploy main first). The route is `GET /api/v1/admin/health` in services/relay/src/index.ts.",
    );
    process.exit(1);
  }
  const body = (await res.json()) as { motebits?: Partial<Population> };
  const m = body.motebits ?? {};
  const need = [
    "identity_keys_total",
    "identity_keys_unambiguous",
    "identity_keys_ambiguous",
    "identity_keys_keyless",
  ] as const;
  const missing = need.filter((k) => typeof m[k] !== "number");
  if (missing.length > 0) {
    console.error(
      `measure-identity-key-ambiguity: the relay's health summary carries no ${missing.join(", ")} — it predates the metric (services/relay/src/health-summary.ts). Deploy main and re-run.`,
    );
    process.exit(1);
  }
  const p = m as Population;
  console.log(`  identities known (registry ∪ devices ∪ successions): ${p.identity_keys_total}`);
  console.log(
    `  unambiguous (backfill can name ONE key):           ${p.identity_keys_unambiguous}`,
  );
  console.log(`  ambiguous (device rows disagree, nothing else):     ${p.identity_keys_ambiguous}`);
  console.log(`  keyless (known by id only):                         ${p.identity_keys_keyless}`);
  console.log(`  serving / registry rows: ${p.total_registered ?? "?"} / ${p.total_known ?? "?"}`);
  console.log(
    `✓ measure-identity-key-ambiguity: ${p.identity_keys_total} identity(ies) examined — ${p.identity_keys_ambiguous} stay unfilled under D5 until their next bootstrap/register.`,
  );
}

main().catch((err: unknown) => {
  console.error(
    `measure-identity-key-ambiguity: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
