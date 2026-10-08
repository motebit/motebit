/**
 * #875 review R2 — a pre-#875 squatter must not take over a sovereign id
 * through any field it planted, least of all one the owner's own bootstrap
 * leaves behind.
 *
 * The reviewer's sequence (both variants end the same way):
 *  A. pre-#875, X writes a registry-only row on V's sovereign id
 *     `deriveSovereignMotebitId(K_V)` with X's key K_X and X's guardian G_X;
 *  B. pre-#875, X writes an identity row + a device row holding K_X; after
 *     #875, X makes a KEYLESS `/agents/register` on V's id with a token that
 *     planted device row verifies, carrying a guardian attestation for G_X.
 * Then V's signed bootstrap with K_V parks the squat — but kept
 * `guardian_public_key = G_X` — and X submits a guardian RECOVERY
 * K_V → K_Y signed by G_X (a recovery skips the old-key signature by
 * design). The link stood in `sovereignLineage`, K_Y was served as V's key,
 * and V was locked out.
 *
 * The class: an authority-bearing field (guardian, registry key, device
 * rows, settlement address, endpoint, listings, a chain, a signed artifact in
 * V's name) written by a party that never proved the identity's key, and
 * surviving the owner's proof. This harness is field-exhaustive:
 *
 *  1. every table that carries an identity column (derived from the live
 *     schema, never a hand list) is classified — PARKED (the owner's proof
 *     clears what a squatter planted), GUARDED (written only under the
 *     identity's current proven key), or INERT (confers no authority over the
 *     identity, with the reason) — and a new table fails until classified;
 *  2. every PARKED/GUARDED field is planted as X through the pre-#875 door
 *     (raw rows, exactly what a relay before #875 admitted) and, where a
 *     post-#875 door exists, through it; V's signed bootstrap runs; then X
 *     tries every follow-up door — rotate-key (normal and recovery), the
 *     register door's recovery, register keyed and keyless, heartbeat, the
 *     listing — and V's served key stays K_V with no X value conferring
 *     anything.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { identityGuardianFor, servedIdentityKey } from "../identity-keys.js";
import { createTestRelay, keyProof, signedBootstrapBody } from "./test-helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);
const ENDPOINT_X = "http://127.0.0.1:9999/x-endpoint";
const SETTLEMENT_X = "So1anaSquatterAddressXXXXXXXXXXXXXXXXXXXX1";

let relay: SyncRelay;
beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

const db = () => relay.moteDb.db;
const run = (sql: string, ...args: unknown[]) =>
  db()
    .prepare(sql)
    .run(...args);
const one = <T>(sql: string, ...args: unknown[]) =>
  db()
    .prepare(sql)
    .get(...args) as T | undefined;
const count = (sql: string, ...args: unknown[]) => (one<{ n: number }>(sql, ...args) ?? { n: 0 }).n;

// ── pre-#875 doors: the rows a relay before #875 admitted without proof ──

const plantIdentity = (mid: string) =>
  run(
    "INSERT OR IGNORE INTO identities (motebit_id, owner_id, created_at, version_clock) VALUES (?, ?, ?, 0)",
    mid,
    mid,
    1,
  );
const plantDevice = (mid: string, device: string, key: string) =>
  run(
    "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
    device,
    mid,
    crypto.randomUUID(),
    key,
    1,
  );
const plantRegistry = (mid: string, key: string, guardian: string | null) =>
  run(
    `INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, metadata, registered_at, last_heartbeat, expires_at, guardian_public_key, federation_visible, settlement_address, settlement_modes, sweep_threshold)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'relay,p2p', 5000000)`,
    mid,
    key,
    ENDPOINT_X,
    '["x_tool"]',
    '{"name":"squatter"}',
    1,
    Date.now(),
    Date.now() + 86_400_000,
    guardian,
    SETTLEMENT_X,
  );

async function guardianFields(mid: string, guardian: KeyPair) {
  const sig = await ed25519Sign(
    new TextEncoder().encode(
      canonicalJson({
        action: "guardian_attestation",
        guardian_public_key: hex(guardian),
        motebit_id: mid,
      }),
    ),
    guardian.privateKey,
  );
  return { guardian_public_key: hex(guardian), guardian_attestation: bytesToHex(sig) };
}

async function token(mid: string, device: string, kp: KeyPair, aud: TokenAudience) {
  return (await mintAudienceToken({ mid, did: device, aud }, kp.privateKey)).token;
}

async function bootstrap(mid: string, device: string, kp: KeyPair) {
  const res = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: JSON_HEADERS,
    body: await signedBootstrapBody(
      { motebit_id: mid, device_id: device, public_key: hex(kp) },
      kp.privateKey,
    ),
  });
  return res.status;
}

async function register(mid: string, device: string, kp: KeyPair, extra: object = {}) {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${await token(mid, device, kp, "admin:query")}`,
    },
    body: JSON.stringify({ endpoint_url: ENDPOINT_X, capabilities: ["x_tool"], ...extra }),
  });
  return res.status;
}

/** A presentation at `/rotate-key`, carried by X's OWN separate identity (a recovery is by design carried by someone else). */
async function rotateAt(target: string, record: unknown, carrier: Carrier) {
  const res = await relay.app.request(`/api/v1/agents/${target}/rotate-key`, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${await token(carrier.mid, carrier.device, carrier.kp, "rotate-key")}`,
    },
    body: JSON.stringify(record),
  });
  return res.status;
}

interface Carrier {
  mid: string;
  device: string;
  kp: KeyPair;
}

async function carrierOf(kp: KeyPair): Promise<Carrier> {
  const mid = await deriveSovereignMotebitId(hex(kp));
  const device = `${mid}-own`;
  expect(ok(await bootstrap(mid, device, kp))).toBe(true);
  return { mid, device, kp };
}

async function servedAll(mid: string) {
  const get = async (path: string) =>
    ((await (await relay.app.request(path)).json()) as { public_key?: string }).public_key ?? "";
  const succession = (await (
    await relay.app.request(`/api/v1/agents/${mid}/succession`)
  ).json()) as {
    current_public_key?: string | null;
  };
  return {
    helper: (await servedIdentityKey(db(), mid)) ?? "",
    discover: await get(`/api/v1/discover/${mid}`),
    agent: await get(`/api/v1/agents/${mid}`),
    succession: succession.current_public_key ?? "",
  };
}

async function cast() {
  const vKp = await generateKeypair();
  const xKp = await generateKeypair();
  const gX = await generateKeypair();
  const yKp = await generateKeypair();
  const v = await deriveSovereignMotebitId(hex(vKp));
  return { vKp, xKp, gX, yKp, v };
}

/** Every door X has left after V's bootstrap: each must leave V served K_V. */
async function xFollowUps(
  c: Awaited<ReturnType<typeof cast>>,
  xDevice: string,
  carrier: Carrier,
): Promise<Record<string, number>> {
  const { v, vKp, xKp, gX, yKp } = c;
  const out: Record<string, number> = {};
  // Guardian recovery K_V → K_Y signed by G_X, at /rotate-key.
  out.recovery_rotate = await rotateAt(
    v,
    await signGuardianRecoverySuccession(
      gX.privateKey,
      yKp.privateKey,
      vKp.publicKey,
      yKp.publicKey,
    ),
    carrier,
  );
  // The same recovery carried by the register door's succession block.
  out.recovery_register = await register(v, xDevice, xKp, {
    public_key: hex(yKp),
    succession: await signGuardianRecoverySuccession(
      gX.privateKey,
      yKp.privateKey,
      vKp.publicKey,
      yKp.publicKey,
    ),
  });
  // A normal rotation from X's own planted key.
  out.rotate_from_kx = await rotateAt(
    v,
    await signKeySuccession(xKp.privateKey, yKp.privateKey, yKp.publicKey, xKp.publicKey),
    carrier,
  );
  // Register keyed (with its own key_proof) and keyless, as X.
  out.register_keyed = await register(v, xDevice, xKp, {
    public_key: hex(xKp),
    key_proof: await keyProof(v, xDevice, xKp),
    ...(await guardianFields(v, gX)),
  });
  out.register_keyless = await register(v, xDevice, xKp, await guardianFields(v, gX));
  // Heartbeat as X.
  out.heartbeat = (
    await relay.app.request("/api/v1/agents/heartbeat", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${await token(v, xDevice, xKp, "admin:query")}`,
      },
      body: "{}",
    })
  ).status;
  return out;
}

const ok = (s: number) => s >= 200 && s < 300;

describe("the reviewer's sequence — V's bootstrap leaves no planted guardian a recovery can use", () => {
  it("variant A: pre-#875 registry-only row with K_X + guardian G_X", async () => {
    const c = await cast();
    const carrier = await carrierOf(await generateKeypair());
    plantRegistry(c.v, hex(c.xKp), hex(c.gX));

    expect(ok(await bootstrap(c.v, `${c.v}-v`, c.vKp))).toBe(true);
    // The parked registry keeps no guardian X planted.
    expect(identityGuardianFor(db(), c.v)).toBeNull();

    const f = await xFollowUps(c, `${c.v}-x`, carrier);
    for (const [door, status] of Object.entries(f))
      expect([door, ok(status)]).toEqual([door, false]);
    expect(await servedAll(c.v)).toEqual({
      helper: hex(c.vKp),
      discover: hex(c.vKp),
      agent: hex(c.vKp),
      succession: hex(c.vKp),
    });
    expect(count("SELECT COUNT(*) AS n FROM relay_key_successions WHERE motebit_id = ?", c.v)).toBe(
      0,
    );
  });

  it("variant B: identity + device row K_X, then a post-#875 KEYLESS register carrying G_X's attestation", async () => {
    const c = await cast();
    const carrier = await carrierOf(await generateKeypair());
    plantIdentity(c.v);
    plantDevice(c.v, `${c.v}-x`, hex(c.xKp));

    // The post-#875 door: keyless, verified by the planted device row only.
    // The identity has no proven key — nothing authority-bearing is written.
    const keyless = await register(c.v, `${c.v}-x`, c.xKp, {
      ...(await guardianFields(c.v, c.gX)),
      settlement_address: SETTLEMENT_X,
    });
    expect(ok(keyless)).toBe(false);
    expect(identityGuardianFor(db(), c.v)).toBeNull();
    expect(
      one<{ s: string | null }>(
        "SELECT settlement_address AS s FROM agent_registry WHERE motebit_id = ?",
        c.v,
      )?.s ?? null,
    ).toBeNull();

    expect(ok(await bootstrap(c.v, `${c.v}-v`, c.vKp))).toBe(true);
    expect(identityGuardianFor(db(), c.v)).toBeNull();

    const f = await xFollowUps(c, `${c.v}-x`, carrier);
    for (const [door, status] of Object.entries(f))
      expect([door, ok(status)]).toEqual([door, false]);
    expect(await servedAll(c.v)).toEqual({
      helper: hex(c.vKp),
      discover: hex(c.vKp),
      agent: hex(c.vKp),
      succession: hex(c.vKp),
    });
  });

  it("variant B': the keyless guardian write landed before this fix (raw guardian on an empty-key registry row) — still parked", async () => {
    const c = await cast();
    const carrier = await carrierOf(await generateKeypair());
    plantIdentity(c.v);
    plantDevice(c.v, `${c.v}-x`, hex(c.xKp));
    plantRegistry(c.v, "", hex(c.gX));

    expect(ok(await bootstrap(c.v, `${c.v}-v`, c.vKp))).toBe(true);
    expect(identityGuardianFor(db(), c.v)).toBeNull();
    const f = await xFollowUps(c, `${c.v}-x`, carrier);
    for (const [door, status] of Object.entries(f))
      expect([door, ok(status)]).toEqual([door, false]);
    expect((await servedAll(c.v)).helper).toBe(hex(c.vKp));
  });

  it("variant C: a guardian recovery a squatter recorded from a planted K_V row before V arrived never stands", async () => {
    // Pre-#875: a device row naming V's PUBLIC key (bootstrap was unsigned)
    // and X's guardian; X's recovery K_V → K_Y then departed from that row.
    const c = await cast();
    plantIdentity(c.v);
    plantDevice(c.v, `${c.v}-planted`, hex(c.vKp));
    plantRegistry(c.v, "", hex(c.gX));
    const rec = await signGuardianRecoverySuccession(
      c.gX.privateKey,
      c.yKp.privateKey,
      c.vKp.publicKey,
      c.yKp.publicKey,
    );
    run(
      "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?)",
      c.v,
      rec.old_public_key,
      rec.new_public_key,
      rec.timestamp,
      rec.reason ?? null,
      rec.new_key_signature,
      rec.guardian_signature,
    );
    run("UPDATE devices SET public_key = ? WHERE motebit_id = ?", hex(c.yKp), c.v);
    run("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?", hex(c.yKp), c.v);

    // K_Y is not V's key, before or after V arrives.
    expect((await servedAll(c.v)).helper).not.toBe(hex(c.yKp));
    expect(ok(await bootstrap(c.v, `${c.v}-v`, c.vKp))).toBe(true);
    expect(await servedAll(c.v)).toEqual({
      helper: hex(c.vKp),
      discover: hex(c.vKp),
      agent: hex(c.vKp),
      succession: hex(c.vKp),
    });
    // V can rotate from its own key: no squat link or row blocks departure.
    const next = await generateKeypair();
    const vRot = await signKeySuccession(
      c.vKp.privateKey,
      next.privateKey,
      next.publicKey,
      c.vKp.publicKey,
    );
    const vCarrier = { mid: c.v, device: `${c.v}-v`, kp: c.vKp };
    expect(await rotateAt(c.v, vRot, vCarrier)).toBe(200);
    expect((await servedAll(c.v)).helper).toBe(hex(next));
  });
});

describe("the reviewer's exact sequence, end to end (no intermediate assertion)", () => {
  for (const variant of ["A", "B"] as const) {
    it(`variant ${variant}: G_X's recovery K_V → K_Y after V's bootstrap is refused, and V stays served K_V`, async () => {
      const c = await cast();
      const carrier = await carrierOf(await generateKeypair());
      if (variant === "A") {
        plantRegistry(c.v, hex(c.xKp), hex(c.gX));
      } else {
        plantIdentity(c.v);
        plantDevice(c.v, `${c.v}-x`, hex(c.xKp));
        await register(c.v, `${c.v}-x`, c.xKp, await guardianFields(c.v, c.gX));
      }
      await bootstrap(c.v, `${c.v}-v`, c.vKp);
      const status = await rotateAt(
        c.v,
        await signGuardianRecoverySuccession(
          c.gX.privateKey,
          c.yKp.privateKey,
          c.vKp.publicKey,
          c.yKp.publicKey,
        ),
        carrier,
      );
      expect({ recovery: ok(status), served: (await servedAll(c.v)).helper }).toEqual({
        recovery: false,
        served: hex(c.vKp),
      });
    });
  }
});

describe("guardian provenance — a guardian is set only under the identity's current proven key", () => {
  it("V's own keyless register with V's guardian, then V's guardian recovers V: lands", async () => {
    const c = await cast();
    const gV = await generateKeypair();
    expect(ok(await bootstrap(c.v, `${c.v}-v`, c.vKp))).toBe(true);
    expect(await register(c.v, `${c.v}-v`, c.vKp, await guardianFields(c.v, gV))).toBe(200);
    expect(identityGuardianFor(db(), c.v)).toBe(hex(gV));
    const carrier = await carrierOf(await generateKeypair());
    const rec = await signGuardianRecoverySuccession(
      gV.privateKey,
      c.yKp.privateKey,
      c.vKp.publicKey,
      c.yKp.publicKey,
    );
    expect(await rotateAt(c.v, rec, carrier)).toBe(200);
    expect((await servedAll(c.v)).helper).toBe(hex(c.yKp));
  });

  it("a guardian on a sovereign id with no recorded provenance (set before this rule) recovers nothing", async () => {
    const c = await cast();
    const gV = await generateKeypair();
    expect(ok(await bootstrap(c.v, `${c.v}-v`, c.vKp))).toBe(true);
    // Written raw: what a relay before the rule held (no provenance row).
    plantRegistry(c.v, hex(c.vKp), hex(gV));
    const carrier = await carrierOf(await generateKeypair());
    const rec = await signGuardianRecoverySuccession(
      gV.privateKey,
      c.yKp.privateKey,
      c.vKp.publicKey,
      c.yKp.publicKey,
    );
    expect(await rotateAt(c.v, rec, carrier)).toBe(400);
    expect((await servedAll(c.v)).helper).toBe(hex(c.vKp));
  });

  it("X's device row coexisting with V's standing key cannot change V's guardian or settlement address", async () => {
    const c = await cast();
    // Pre-#875: V's own device row AND X's planted row — park never runs
    // (a standing key is on file), so the guard has to hold at the write.
    plantIdentity(c.v);
    plantDevice(c.v, `${c.v}-v`, hex(c.vKp));
    plantDevice(c.v, `${c.v}-x`, hex(c.xKp));
    expect(ok(await register(c.v, `${c.v}-x`, c.xKp, await guardianFields(c.v, c.gX)))).toBe(false);
    expect(ok(await register(c.v, `${c.v}-x`, c.xKp, { settlement_address: SETTLEMENT_X }))).toBe(
      false,
    );
    expect(identityGuardianFor(db(), c.v)).toBeNull();
    const carrier = await carrierOf(await generateKeypair());
    expect(
      await rotateAt(
        c.v,
        await signGuardianRecoverySuccession(
          c.gX.privateKey,
          c.yKp.privateKey,
          c.vKp.publicKey,
          c.yKp.publicKey,
        ),
        carrier,
      ),
    ).toBe(400);
    expect((await servedAll(c.v)).helper).toBe(hex(c.vKp));
  });
});

// ── 1. The schema, classified ──

/** The gate's identity-column rule (`check-identity-authority-writers`), applied to the live schema. */
const IDENTITY_COLUMN =
  /^(motebit_id|\w+_motebit_id|agent_id|worker_id|submitted_by|submitter_id|delegator_id|filed_by|respondent|approver_id|owner_id|revoked_by)$/;

type Verdict = "parked" | "inert";
/**
 * Every table with an identity column. PARKED: `parkSovereignSquat` clears
 * what a squatter planted (and the guarded columns are written only under the
 * proven key). INERT: the reason it confers no authority over the identity —
 * what V is served, who may rotate or recover it, where it is paid.
 */
const CLASSIFIED: Record<string, [Verdict, string]> = {
  agent_registry: [
    "parked",
    "key, guardian, endpoint, capabilities, metadata, settlement address/modes, sweep threshold — cleared and delisted; guardian/settlement written only under the proven key",
  ],
  devices: ["parked", "each non-standing keyed row verified tokens AS the identity — removed"],
  identity_keys: ["parked", "a non-standing holder (E-main/E-op transplant of a squat) — removed"],
  relay_registry_key_evidence: ["parked", "provenance of the squatted registry key — dropped"],
  relay_guardian_evidence: [
    "parked",
    "guardian provenance recorded under a key that does not stand — dropped",
  ],
  relay_service_listings: [
    "parked",
    "the squatter's listing (capabilities, pricing, pay_to_address) — removed",
  ],
  relay_push_tokens: ["parked", "push tokens of the parked device rows — removed"],
  pairing_sessions: [
    "parked",
    "every pairing of an identity with no standing key is the squatter's (approve writes device rows) — removed",
  ],
  relay_key_successions: [
    "parked",
    "links that do not stand (a squat chain, an unproven recovery) — removed; they set departure",
  ],
  relay_delegation_revocations: [
    "parked",
    "revocations signed in V's name by a key that does not stand fence V's tasks — removed",
  ],
  relay_bond_commitments: [
    "parked",
    "a bond under a key that does not stand is an eligibility signal for V on X's word — removed",
  ],
};

describe("1 — every table keyed by an identity is classified", () => {
  it("the live schema's identity tables are exactly the classified ones", () => {
    const tables = (
      db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    const keyed = tables
      .filter((t) =>
        (db().prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).some((c) =>
          IDENTITY_COLUMN.test(c.name),
        ),
      )
      .sort();
    const unclassified = keyed.filter((t) => !(t in CLASSIFIED) && !(t in INERT));
    const stale = [...Object.keys(CLASSIFIED), ...Object.keys(INERT)].filter(
      (t) => !keyed.includes(t),
    );
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });
});

/** INERT tables, each with why it confers no authority over the identity's key, recovery or pay-to. */
const SYNCED =
  "the identity's own synced interior data — written only through a BoundIdentity (rule 26); no key, guardian, departure or pay-to is read from it";
const LOCAL =
  "a surface-local runtime table the relay's schema shares (persistence package); no relay route reads it as authority";
const MONEY =
  "money or settlement history the identity holds or owes — moved only by its own ledger rules (rule 29); park never moves money, and nothing here names a key or pay-to the relay serves";
const AUDIT =
  "an append-only record of what happened (receipts, events, audit) — read as history, never as the identity's key, guardian, departure or pay-to";
const INERT: Record<string, string> = {
  agent_trust: LOCAL,
  approval_queue: LOCAL,
  audit_log: LOCAL,
  budget_allocations: LOCAL,
  conversation_messages: LOCAL,
  conversations: LOCAL,
  goal_outcomes: LOCAL,
  goal_runs: LOCAL,
  goals: LOCAL,
  gradient_snapshots: LOCAL,
  halt_state: LOCAL,
  issued_credentials: LOCAL,
  latency_stats: LOCAL,
  memory_nodes: LOCAL,
  paid_intent_ledger: LOCAL,
  plan_steps: LOCAL,
  plans: LOCAL,
  runtime_liveness: LOCAL,
  service_listings: LOCAL,
  settlements: LOCAL,
  state_snapshots: LOCAL,
  events: SYNCED,
  sync_conversation_messages: SYNCED,
  sync_conversations: SYNCED,
  sync_plan_steps: SYNCED,
  sync_plans: SYNCED,
  relay_event_seq: SYNCED,
  relay_event_seq_counter: SYNCED,
  relay_approval_metadata: SYNCED,
  relay_approval_votes: SYNCED,
  identities:
    "existence only (owner_id is the id itself for a self-registered identity); no key, guardian or pay-to column",
  relay_accounts: MONEY,
  relay_transactions: MONEY,
  relay_withdrawals: MONEY,
  relay_pending_withdrawals: MONEY,
  relay_allocations: MONEY,
  relay_settlements: MONEY,
  relay_federation_settlements: MONEY,
  relay_settlement_payee_corrections: MONEY,
  relay_x402_settlements: MONEY,
  relay_refund_log: MONEY,
  relay_deposit_log: MONEY,
  relay_p2p_proof_claims: MONEY,
  relay_subscriptions: MONEY,
  relay_agent_wallets:
    "a deposit address whose inbound transfers CREDIT the identity's account — money in, never a destination the identity is paid at or a key",
  relay_receipts: AUDIT,
  relay_auth_events: AUDIT,
  relay_revocation_events: AUDIT,
  relay_execution_ledgers: AUDIT,
  relay_task_queue: AUDIT,
  relay_idempotency_keys: AUDIT,
  relay_delegation_edges: AUDIT,
  relay_latency_stats: AUDIT,
  relay_collaborative_step_results: AUDIT,
  relay_proposals: AUDIT,
  relay_proposal_participants: AUDIT,
  relay_disputes: AUDIT,
  relay_dispute_evidence: AUDIT,
  relay_witness_omission_disputes: AUDIT,
  relay_key_proofs_accepted:
    "replay record of an accepted proof (11-minute retention) — an accepted proof is answered idempotently and authorizes nothing new",
  relay_identity: "the relay's OWN identity row",
  relay_credentials:
    "credentials ABOUT the identity, each verified under its issuer; bound to the subject by evidence only (bindCredentialSubject) — never a key, guardian or pay-to",
  relay_revoked_credentials:
    "a revocation of a credential by its issuer or subject — ends a credential, confers no authority over the identity's key (a squatter's pre-#875 revocations are a stated denial residual)",
  relay_skill_registry:
    "the submitter is the did:key of the envelope's own signer, never a motebit_id a request names",
  relay_host_roster_entries:
    "entries held verbatim; the roster law verifies each against the sovereign's key history client-side (`verifyHostRoster`) — the relay never reduces it",
  relay_host_liveness:
    "observed liveness only; no quantified claim is computed over it (machine-roster doctrine)",
  relay_motebit_intake:
    "a signed announcement counted for health metrics; no route reads its key as the identity's",
  relay_token_blacklist:
    "an identity's revocation of its OWN token ids (keyed by identity + jti); revokes, never grants",
  relay_identity_revocations:
    "a revocation record ENDS the identity's tokens; lifted only by migration arrival or the operator (rule 22) — a squatter's pre-#875 `/revoke` is a denial residual, never a takeover",
  relay_agent_revocations:
    "the operator's signed revocation feed — the operator's act, not a request's",
  relay_migrations:
    "a departure token ends the identity here (revocation, a denial residual like /revoke), never moves its key; arrival is verified by the sovereign binding",
  relay_accepted_migrations: "written only after a migration's sovereign binding verified (E-mig)",
};

// ── 2. Every parked field, planted, then V's bootstrap, then X's doors ──

const tableExists = (t: string) =>
  one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t) !== undefined;

/** Plant one X value in every PARKED table, the way a relay before #875 admitted it. */
async function plantEverything(c: Awaited<ReturnType<typeof cast>>, xDevice: string) {
  const { v, xKp, gX } = c;
  const kx = hex(xKp);
  const kx2 = hex(await generateKeypair());
  plantIdentity(v);
  plantDevice(v, xDevice, kx);
  plantRegistry(v, kx, hex(gX));
  run(
    "INSERT INTO relay_registry_key_evidence (motebit_id, public_key, evidence, recorded_at) VALUES (?, ?, 'bearer', 1)",
    v,
    kx,
  );
  run(
    "INSERT INTO identity_keys (motebit_id, public_key, guardian_public_key, source, first_seen, updated_at) VALUES (?, ?, ?, 'backfill:registry', 1, 1)",
    v,
    kx,
    hex(gX),
  );
  if (tableExists("relay_guardian_evidence")) {
    run(
      "INSERT INTO relay_guardian_evidence (motebit_id, guardian_public_key, set_under_key, evidence, recorded_at) VALUES (?, ?, ?, 'bearer', 1)",
      v,
      hex(gX),
      kx,
    );
  }
  run(
    'INSERT INTO relay_service_listings (listing_id, motebit_id, capabilities, pricing, description, pay_to_address, updated_at) VALUES (?, ?, \'["x_tool"]\', \'[{"capability":"x_tool","unit_cost":1}]\', \'squat\', ?, 1)',
    `ls-${crypto.randomUUID()}`,
    v,
    "0x000000000000000000000000000000000000dEaD",
  );
  run(
    "INSERT INTO relay_push_tokens (motebit_id, device_id, push_token, platform, registered_at) VALUES (?, ?, 'x-push', 'ios', 1)",
    v,
    xDevice,
  );
  run(
    "INSERT INTO pairing_sessions (pairing_id, motebit_id, initiator_device_id, pairing_code, status, claiming_public_key, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
    crypto.randomUUID(),
    v,
    xDevice,
    `X${Math.floor(Math.random() * 1e9)}`,
    kx2,
    Date.now(),
    Date.now() + 600_000,
  );
  run(
    "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, old_key_signature, new_key_signature) VALUES (?, ?, ?, ?, 'aa', 'bb')",
    v,
    kx,
    kx2,
    Date.now() - 60_000,
  );
  run(
    "INSERT INTO relay_delegation_revocations (grant_id, delegator_id, delegator_public_key, revoked_at, suite, signature, record_json, received_at) VALUES (?, ?, ?, 1, 'motebit-jcs-ed25519-b64-v1', ?, '{}', 1)",
    `grant-${crypto.randomUUID()}`,
    v,
    kx,
    `sig-${crypto.randomUUID()}`,
  );
  run(
    "INSERT INTO relay_bond_commitments (bond_id, motebit_id, bonded_address, bonded_public_key, bond_amount_micro, asset, chain, issued_at, expires_at, suite, signature, commitment_json, recorded_at) VALUES (?, ?, 'addr', ?, 1, 'USDC', 'solana', 1, ?, 'motebit-jcs-ed25519-b64-v1', 'sig', '{}', 1)",
    `bond-${crypto.randomUUID()}`,
    v,
    kx,
    Date.now() + 86_400_000,
  );
}

/** What X planted that is still on V's id, per PARKED table (each must be empty). */
function xResidue(v: string, xDevice: string, kx: string, gx: string) {
  const reg = one<Record<string, unknown>>("SELECT * FROM agent_registry WHERE motebit_id = ?", v);
  return {
    agent_registry: reg
      ? Object.entries({
          public_key: reg.public_key === kx,
          guardian_public_key: reg.guardian_public_key === gx,
          endpoint_url: reg.endpoint_url === ENDPOINT_X,
          capabilities: String(reg.capabilities).includes("x_tool"),
          metadata: String(reg.metadata).includes("squatter"),
          settlement_address: reg.settlement_address === SETTLEMENT_X,
          settlement_modes: String(reg.settlement_modes).includes("p2p"),
          sweep_threshold: reg.sweep_threshold != null,
          on_shelf: reg.delisted_at == null,
        })
          .filter(([, planted]) => planted)
          .map(([k]) => k)
      : [],
    devices: count(
      "SELECT COUNT(*) AS n FROM devices WHERE motebit_id = ? AND (device_id = ? OR public_key = ?)",
      v,
      xDevice,
      kx,
    ),
    identity_keys: count(
      "SELECT COUNT(*) AS n FROM identity_keys WHERE motebit_id = ? AND (public_key = ? OR guardian_public_key = ?)",
      v,
      kx,
      gx,
    ),
    relay_registry_key_evidence: count(
      "SELECT COUNT(*) AS n FROM relay_registry_key_evidence WHERE motebit_id = ? AND public_key = ?",
      v,
      kx,
    ),
    relay_guardian_evidence: tableExists("relay_guardian_evidence")
      ? count(
          "SELECT COUNT(*) AS n FROM relay_guardian_evidence WHERE motebit_id = ? AND (guardian_public_key = ? OR set_under_key = ?)",
          v,
          gx,
          kx,
        )
      : 0,
    relay_service_listings: count(
      "SELECT COUNT(*) AS n FROM relay_service_listings WHERE motebit_id = ?",
      v,
    ),
    relay_push_tokens: count(
      "SELECT COUNT(*) AS n FROM relay_push_tokens WHERE motebit_id = ? AND device_id = ?",
      v,
      xDevice,
    ),
    pairing_sessions: count(
      "SELECT COUNT(*) AS n FROM pairing_sessions WHERE motebit_id = ? AND initiator_device_id = ?",
      v,
      xDevice,
    ),
    relay_key_successions: count(
      "SELECT COUNT(*) AS n FROM relay_key_successions WHERE motebit_id = ? AND old_public_key = ?",
      v,
      kx,
    ),
    relay_delegation_revocations: count(
      "SELECT COUNT(*) AS n FROM relay_delegation_revocations WHERE delegator_id = ? AND delegator_public_key = ?",
      v,
      kx,
    ),
    relay_bond_commitments: count(
      "SELECT COUNT(*) AS n FROM relay_bond_commitments WHERE motebit_id = ? AND bonded_public_key = ?",
      v,
      kx,
    ),
  };
}

const CLEAN = {
  agent_registry: [],
  devices: 0,
  identity_keys: 0,
  relay_registry_key_evidence: 0,
  relay_guardian_evidence: 0,
  relay_service_listings: 0,
  relay_push_tokens: 0,
  pairing_sessions: 0,
  relay_key_successions: 0,
  relay_delegation_revocations: 0,
  relay_bond_commitments: 0,
};

describe("2 — every parked field: planted by X, then V's bootstrap, then every door X has left", () => {
  it("the residue check covers exactly the PARKED tables", () => {
    expect(Object.keys(CLEAN).sort()).toEqual(
      Object.entries(CLASSIFIED)
        .filter(([, [verdict]]) => verdict === "parked")
        .map(([t]) => t)
        .sort(),
    );
  });

  it("everything X planted pre-#875 is parked by V's signed bootstrap, and no X door moves V's key", async () => {
    const c = await cast();
    const xDevice = `${c.v}-x`;
    const carrier = await carrierOf(await generateKeypair());
    await plantEverything(c, xDevice);
    expect(xResidue(c.v, xDevice, hex(c.xKp), hex(c.gX))).not.toEqual(CLEAN);

    expect(ok(await bootstrap(c.v, `${c.v}-v`, c.vKp))).toBe(true);
    expect(xResidue(c.v, xDevice, hex(c.xKp), hex(c.gX))).toEqual(CLEAN);
    expect(identityGuardianFor(db(), c.v)).toBeNull();

    const f = await xFollowUps(c, xDevice, carrier);
    for (const [door, status] of Object.entries(f))
      expect([door, ok(status)]).toEqual([door, false]);
    expect(xResidue(c.v, xDevice, hex(c.xKp), hex(c.gX))).toEqual(CLEAN);
    expect(await servedAll(c.v)).toEqual({
      helper: hex(c.vKp),
      discover: hex(c.vKp),
      agent: hex(c.vKp),
      succession: hex(c.vKp),
    });
    // V's own doors work: keyless register (E-sov) with V's guardian, then V rotates.
    const gV = await generateKeypair();
    expect(await register(c.v, `${c.v}-v`, c.vKp, await guardianFields(c.v, gV))).toBe(200);
    expect(identityGuardianFor(db(), c.v)).toBe(hex(gV));
    const next = await generateKeypair();
    expect(
      await rotateAt(
        c.v,
        await signKeySuccession(c.vKp.privateKey, next.privateKey, next.publicKey, c.vKp.publicKey),
        { mid: c.v, device: `${c.v}-v`, kp: c.vKp },
      ),
    ).toBe(200);
    expect((await servedAll(c.v)).helper).toBe(hex(next));
  });

  // The GUARDED register fields, through the post-#875 door, in both states a
  // squatter's device row can be in: alone on V's id (no proven key), and
  // beside V's standing key (park never runs).
  const GUARDED: Array<[string, (c: Awaited<ReturnType<typeof cast>>) => Promise<object>]> = [
    ["guardian_public_key", (c) => guardianFields(c.v, c.gX)],
    ["settlement_address", async () => ({ settlement_address: SETTLEMENT_X })],
    ["settlement_modes", async () => ({ settlement_modes: "p2p" })],
    ["sweep_threshold", async () => ({ sweep_threshold: 5_000_000 })],
  ];
  for (const [field, body] of GUARDED) {
    for (const state of ["x_alone", "beside_v"] as const) {
      it(`a keyless register by X's planted row cannot write ${field} (${state})`, async () => {
        const c = await cast();
        plantIdentity(c.v);
        if (state === "beside_v") plantDevice(c.v, `${c.v}-v`, hex(c.vKp));
        plantDevice(c.v, `${c.v}-x`, hex(c.xKp));
        const before =
          one<Record<string, unknown>>("SELECT * FROM agent_registry WHERE motebit_id = ?", c.v) ??
          null;
        expect(ok(await register(c.v, `${c.v}-x`, c.xKp, await body(c)))).toBe(false);
        const after =
          one<Record<string, unknown>>("SELECT * FROM agent_registry WHERE motebit_id = ?", c.v) ??
          null;
        expect(after).toEqual(before);
        expect(identityGuardianFor(db(), c.v)).toBeNull();
      });
    }
  }
});
