/**
 * Differential probe — identity-authority Inc 2's money doors WITHOUT an
 * `X-Motebit-Authority` header must answer exactly as origin/main does
 * (docs/design/identity-authority-writers.md §7 "Inc 2 shipped": refuses
 * nothing new). Run through the differential harness:
 *
 *   npx tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/identity-authority-doors.probe.ts
 *
 * It talks only through surfaces both trees have (HTTP routes, the test
 * helpers, direct SQL reads), and records, with roles in place of keys and
 * ids:
 *
 *   - `door:*` — each money door (#1 register, #3 sweep-config, #4–5 listing,
 *     #6 withdraw) × caller {owner device, paired device, operator}: the
 *     response, and the authority values the door writes, read back;
 *   - `lineage:*` — the Inc 2 cold review's two shapes, driven header-less:
 *     F1 (a paired device plants a guardian and recovers a sovereign id) and
 *     F2 (a `backfill:registry` holder rotates itself), each step's response
 *     and then the money write that follows;
 *   - `db:*` — the identity-key rows those shapes leave. ONE difference here
 *     is intended: a holder moved by a succession keeps its predecessor's
 *     `source` (it inherits evidence, never creates it — F2), where main
 *     writes `succession`. It is not a door observation.
 */
import { afterAll, beforeAll, it } from "vitest";
import { writeFileSync } from "node:fs";
import {
  bytesToHex,
  canonicalJson,
  deriveSovereignMotebitId,
  ed25519Sign,
  generateKeypair,
  mintAudienceToken,
  signGuardianRecoverySuccession,
  signKeySuccession,
  type KeyPair,
} from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay, seedBalance, walletOf } from "./test-helpers.js";

const obs: Record<string, unknown> = {};
let relay: SyncRelay;
beforeAll(async () => {
  relay = await createTestRelay();
});
afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  await relay.close();
});

const db = () => relay.moteDb.db;
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);
const ENDPOINT = "http://127.0.0.1:9999/mcp";
let ip = 0;

/** Role names for every per-run value, filled as the cast is made. */
const roles = new Map<string, string>();
function role(value: string, name: string): string {
  roles.set(value, name);
  return value;
}
function normalize(v: unknown, key: string | null = null): unknown {
  if (typeof v === "string") {
    if (roles.has(v)) return `<${roles.get(v)}>`;
    let s: string = v;
    for (const [val, name] of roles) if (s.includes(val)) s = s.split(val).join(`<${name}>`);
    if (/^ls-[0-9a-f-]{36}$/.test(s)) return "<LISTING_ID>";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return "<UUID>";
    if (key !== null && /(_at|_id)$/.test(key)) return `<${key}>`;
    return s;
  }
  if (typeof v === "number" && key !== null && /(_at|^timestamp$|^ts$|_heartbeat$)/.test(key))
    return `<${key}>`;
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, k)]));
  return v;
}

async function req(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await relay.app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `198.51.100.${++ip % 250}`,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body: normalize(parsed) };
}

async function bearer(mid: string, did: string, kp: KeyPair, aud: TokenAudience) {
  return {
    Authorization: `Bearer ${(await mintAudienceToken({ mid, did, aud }, kp.privateKey)).token}`,
  };
}

function plantDevice(mid: string, did: string, key: string): void {
  db()
    .prepare(
      "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(did, mid, `tok-${did}`, key, 3_000);
}

async function guardianFields(mid: string, g: KeyPair) {
  return {
    guardian_public_key: hex(g),
    guardian_attestation: bytesToHex(
      await ed25519Sign(
        new TextEncoder().encode(
          canonicalJson({
            action: "guardian_attestation",
            guardian_public_key: hex(g),
            motebit_id: mid,
          }),
        ),
        g.privateKey,
      ),
    ),
  };
}

const snapshot = (mid: string) =>
  normalize({
    registry: db()
      .prepare(
        "SELECT public_key, endpoint_url, capabilities, guardian_public_key, settlement_address, settlement_modes, sweep_threshold, revoked, delisted_at FROM agent_registry WHERE motebit_id = ?",
      )
      .get(mid),
    listings: db()
      .prepare(
        "SELECT capabilities, pricing, pay_to_address FROM relay_service_listings WHERE motebit_id = ? ORDER BY listing_id",
      )
      .all(mid),
    withdrawals: db()
      .prepare(
        "SELECT amount, destination, status FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at",
      )
      .all(mid),
    devices: db()
      .prepare("SELECT device_id, public_key FROM devices WHERE motebit_id = ? ORDER BY device_id")
      .all(mid),
  });

async function sovereignCast(tag: string) {
  const owner = await generateKeypair();
  const paired = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(owner));
  role(mid, `${tag}:V`);
  role(hex(owner), `${tag}:K`);
  role(hex(paired), `${tag}:K_P`);
  role(walletOf(hex(owner)), `${tag}:WALLET`);
  role(`${tag}-owner`, `${tag}:owner-dev`);
  role(`${tag}-paired`, `${tag}:paired-dev`);
  const boot = await req(
    "POST",
    "/api/v1/agents/bootstrap",
    {},
    {
      motebit_id: mid,
      device_id: `${tag}-owner`,
      public_key: hex(owner),
    },
  );
  plantDevice(mid, `${tag}-paired`, hex(paired));
  return { owner, paired, mid, wallet: walletOf(hex(owner)), boot, tag };
}
type Cast = Awaited<ReturnType<typeof sovereignCast>>;

type Who = "owner" | "paired" | "operator";
async function as(c: Cast, who: Who, aud: TokenAudience): Promise<Record<string, string>> {
  if (who === "operator") return AUTH_HEADER;
  return who === "owner"
    ? bearer(c.mid, `${c.tag}-owner`, c.owner, aud)
    : bearer(c.mid, `${c.tag}-paired`, c.paired, aud);
}

const operatorRegister = (mid: string) =>
  req("POST", "/api/v1/agents/register", AUTH_HEADER, {
    motebit_id: mid,
    endpoint_url: ENDPOINT,
    capabilities: ["seed"],
  });

it("probes every money door without a header, as each caller", async () => {
  for (const who of ["owner", "paired", "operator"] as const) {
    // #1 register
    {
      const c = await sovereignCast(`reg-${who}`);
      const res = await req("POST", "/api/v1/agents/register", await as(c, who, "admin:query"), {
        ...(who === "operator" ? { motebit_id: c.mid } : {}),
        endpoint_url: ENDPOINT,
        capabilities: ["web_search"],
        settlement_address: c.wallet,
        sweep_threshold: 5_000_000,
      });
      obs[`door:register/${who}`] = res;
      obs[`door:register/${who}/after`] = snapshot(c.mid);
    }
    // #3 sweep-config
    {
      const c = await sovereignCast(`sweep-${who}`);
      await operatorRegister(c.mid);
      const res = await req(
        "PATCH",
        `/api/v1/agents/${c.mid}/sweep-config`,
        await as(c, who, "admin:query"),
        { sweep_threshold: 7_000_000, settlement_address: c.wallet },
      );
      obs[`door:sweep_config/${who}`] = res;
      obs[`door:sweep_config/${who}/after`] = snapshot(c.mid);
    }
    // #4–5 listing
    {
      const c = await sovereignCast(`list-${who}`);
      await operatorRegister(c.mid);
      const res = await req(
        "POST",
        `/api/v1/agents/${c.mid}/listing`,
        await as(c, who, "market:listing"),
        {
          capabilities: ["web_search"],
          pricing: [{ capability: "web_search", unit_cost: 0.05, currency: "USD", per: "request" }],
          pay_to_address: c.wallet,
        },
      );
      obs[`door:listing/${who}`] = res;
      obs[`door:listing/${who}/after`] = snapshot(c.mid);
    }
    // #6 withdraw
    {
      const c = await sovereignCast(`wd-${who}`);
      seedBalance(relay, c.mid, 10);
      const res = await req(
        "POST",
        `/api/v1/agents/${c.mid}/withdraw`,
        { ...(await as(c, who, "account:withdraw")), "Idempotency-Key": crypto.randomUUID() },
        { amount: 1, destination: c.wallet },
      );
      obs[`door:withdraw/${who}`] = res;
      obs[`door:withdraw/${who}/after`] = snapshot(c.mid);
    }
  }
});

it("probes F1 header-less: a paired device plants a guardian, recovers V, then moves money", async () => {
  const c = await sovereignCast("f1");
  const g = await generateKeypair();
  const att = await generateKeypair();
  role(hex(g), "f1:G");
  role(hex(att), "f1:K_att");
  const steps: Record<string, unknown> = { boot: c.boot };
  steps["owner_register"] = await req(
    "POST",
    "/api/v1/agents/register",
    await as(c, "owner", "admin:query"),
    {
      endpoint_url: ENDPOINT,
      capabilities: [],
    },
  );
  steps["paired_plants_guardian"] = await req(
    "POST",
    "/api/v1/agents/register",
    await as(c, "paired", "admin:query"),
    { endpoint_url: ENDPOINT, capabilities: [], ...(await guardianFields(c.mid, g)) },
  );
  const recovery = await signGuardianRecoverySuccession(
    g.privateKey,
    att.privateKey,
    c.owner.publicKey,
    att.publicKey,
  );
  steps["recovery"] = await req(
    "POST",
    `/api/v1/agents/${c.mid}/rotate-key`,
    await as(c, "paired", "rotate-key"),
    recovery,
  );
  steps["sweep"] = await req(
    "PATCH",
    `/api/v1/agents/${c.mid}/sweep-config`,
    await as(c, "paired", "admin:query"),
    {
      sweep_threshold: 3_000_000,
    },
  );
  for (const [k, v] of Object.entries(steps)) obs[`lineage:F1/${k}`] = v;
  obs["lineage:F1/after"] = snapshot(c.mid);
});

it("probes F2 header-less: a backfill:registry holder rotates itself, then moves money", async () => {
  const k = await generateKeypair();
  const k2 = await generateKeypair();
  const mid = crypto.randomUUID();
  role(mid, "f2:V");
  role(hex(k), "f2:K");
  role(hex(k2), "f2:K2");
  role("f2-dev", "f2:dev");
  plantDevice(mid, "f2-dev", hex(k));
  const steps: Record<string, unknown> = {};
  steps["operator_register"] = await operatorRegister(mid);
  // What v42's backfill leaves for an identity whose registry key is main's (E-main).
  db()
    .prepare(
      "INSERT INTO identity_keys (motebit_id, public_key, guardian_public_key, source, first_seen, updated_at) VALUES (?, ?, NULL, 'backfill:registry', 1, 1)",
    )
    .run(mid, hex(k));
  const rec = await signKeySuccession(k.privateKey, k2.privateKey, k2.publicKey, k.publicKey);
  steps["rotate"] = await req(
    "POST",
    `/api/v1/agents/${mid}/rotate-key`,
    await bearer(mid, "f2-dev", k, "rotate-key"),
    rec,
  );
  steps["sweep"] = await req(
    "PATCH",
    `/api/v1/agents/${mid}/sweep-config`,
    await bearer(mid, "f2-dev", k2, "admin:query"),
    { sweep_threshold: 3_000_000 },
  );
  for (const [k, v] of Object.entries(steps)) obs[`lineage:F2/${k}`] = v;
  obs["lineage:F2/after"] = snapshot(mid);
  obs["db:F2/identity_keys"] = normalize(
    db().prepare("SELECT public_key, source FROM identity_keys WHERE motebit_id = ?").get(mid),
  );
});
