/**
 * #846 v2 — every door that writes a per-identity row binds the caller to the
 * identity it writes (identity-binding.ts `bindCaller`).
 *
 * The agent-route middleware verifies a token and records its `mid`, but it
 * never compares that `mid` to the path, and the subscription routes had no
 * authentication at all. Proven before this fix (the #847 review probe):
 *   - an unauthenticated POST cancelled a victim's Stripe subscription;
 *   - A's `admin:query` token cancelled B's migration, and departed B —
 *     revoking B here and closing B's sockets;
 *   - A's token filed approval requests under B;
 *   - A's token exported B's credential bundle and minted B's departure
 *     attestation (each advancing B's migration state).
 *
 * For each door: another identity's token is refused 403 and recorded under
 * the presenter with no state change; no credential is refused 401 with no
 * state change; the identity's own token and the operator's master token are
 * unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  mintAudienceToken,
  signMigrationRequest,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay, signedBootstrapBody } from "./test-helpers.js";

const stripeCalls: Array<{ id: string; args: unknown }> = [];
vi.mock("stripe", () => {
  class Stripe {
    subscriptions = {
      update: (id: string, args: unknown) => {
        stripeCalls.push({ id, args });
        return Promise.resolve({ id, items: { data: [{ current_period_end: 2_000_000_000 }] } });
      },
    };
  }
  return { default: Stripe };
});

let relay: SyncRelay;
let prevKey: string | undefined;

interface Ident {
  id: string;
  kp: KeyPair;
  tok: (aud: string) => Promise<string>;
}

async function ident(device: string): Promise<Ident> {
  const kp = await generateKeypair();
  const id = crypto.randomUUID();
  await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await signedBootstrapBody(
      { motebit_id: id, device_id: device, public_key: bytesToHex(kp.publicKey) },
      kp.privateKey,
    ),
  });
  const reg = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: id,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["x"],
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  expect(reg.status).toBeLessThan(300);
  const tok = async (aud: string) =>
    (await mintAudienceToken({ mid: id, did: device, aud }, kp.privateKey)).token;
  return { id, kp, tok };
}

const q = <T>(sql: string, ...a: unknown[]): T[] => relay.moteDb.db.prepare(sql).all(...a) as T[];
const refusals = (reasonPrefix: string) =>
  q<{ kind: string; motebit_id: string | null; reason: string; path: string }>(
    "SELECT kind, motebit_id, reason, path FROM relay_auth_events WHERE reason LIKE ?",
    `${reasonPrefix}%`,
  );

/**
 * The no-credential refusal's row (#846 v3): rule 6's "every refusal is
 * recorded" was false exactly here — the auth layer threw 401 before any
 * token was parsed, and wrote nothing. Presenter null: nothing was claimed.
 */
const missingTokenRows = (path: string) =>
  q<{ kind: string; motebit_id: string | null; reason: string }>(
    "SELECT kind, motebit_id, reason FROM relay_auth_events WHERE reason = 'missing_token' AND path = ?",
    path,
  );

async function post(path: string, bearer: string | null, body?: unknown): Promise<Response> {
  return relay.app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer != null ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function get(path: string, bearer: string | null): Promise<Response> {
  return relay.app.request(path, {
    headers: bearer != null ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

beforeEach(async () => {
  prevKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_846";
  stripeCalls.length = 0;
  relay = await createTestRelay();
});
afterEach(async () => {
  if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = prevKey;
  await relay.close();
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

describe("subscription cancel / resubscribe bind to the caller's own identity", () => {
  const seed = (id: string, status: string) =>
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_subscriptions (motebit_id, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at) VALUES (?, 'cus_x', ?, ?, 1, 1)",
      )
      .run(id, `sub_${id}`, status);
  const statusOf = (id: string) =>
    q<{ status: string }>("SELECT status FROM relay_subscriptions WHERE motebit_id = ?", id)[0]!
      .status;

  const cases = [
    { route: "cancel", from: "active", to: "cancelling" },
    { route: "resubscribe", from: "cancelling", to: "active" },
  ] as const;

  for (const { route, from, to } of cases) {
    it(`${route}: no credential is refused 401 — no Stripe call, no row change`, async () => {
      const B = await ident("b-dev");
      seed(B.id, from);
      const res = await post(`/api/v1/subscriptions/${B.id}/${route}`, null);
      expect(res.status).toBe(401);
      expect(stripeCalls).toHaveLength(0);
      expect(statusOf(B.id)).toBe(from);
      expect(missingTokenRows(`/api/v1/subscriptions/${B.id}/${route}`)).toEqual([
        { kind: "device_token_rejected", motebit_id: null, reason: "missing_token" },
      ]);
    });

    it(`${route}: another identity's token is refused 403, recorded — no Stripe call, no row change`, async () => {
      const A = await ident("a-dev");
      const B = await ident("b-dev");
      seed(B.id, from);
      const res = await post(
        `/api/v1/subscriptions/${B.id}/${route}`,
        await A.tok("account:checkout"),
      );
      expect(res.status).toBe(403);
      expect(stripeCalls).toHaveLength(0);
      expect(statusOf(B.id)).toBe(from);
      expect(refusals(`subscription:${route}`)).toEqual([
        {
          kind: "agent_token_rejected",
          motebit_id: A.id,
          reason: `subscription:${route}:not_own_identity`,
          path: `/api/v1/subscriptions/${B.id}/${route}`,
        },
      ]);
    });

    it(`${route}: the identity's own token is unchanged`, async () => {
      const B = await ident("b-dev");
      seed(B.id, from);
      const res = await post(
        `/api/v1/subscriptions/${B.id}/${route}`,
        await B.tok("account:checkout"),
      );
      expect(res.status).toBe(200);
      expect(stripeCalls).toEqual([
        { id: `sub_${B.id}`, args: { cancel_at_period_end: route === "cancel" } },
      ]);
      expect(statusOf(B.id)).toBe(to);
    });

    it(`${route}: the operator's master token is unchanged`, async () => {
      const B = await ident("b-dev");
      seed(B.id, from);
      const res = await post(`/api/v1/subscriptions/${B.id}/${route}`, "test-token");
      expect(res.status).toBe(200);
      expect(statusOf(B.id)).toBe(to);
    });
  }
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("migration routes bind to the identity itself", () => {
  async function initiate(B: Ident): Promise<void> {
    const req = await signMigrationRequest(
      {
        motebit_id: B.id,
        reason: "r",
        requested_at: Date.now(),
        suite: "motebit-jcs-ed25519-b64-v1",
      } as never,
      B.kp.privateKey,
    );
    const res = await post(`/api/v1/agents/${B.id}/migrate`, await B.tok("admin:query"), req);
    expect(res.status).toBe(200);
  }
  const state = (id: string) =>
    q<{ state: string }>("SELECT state FROM relay_migrations WHERE motebit_id = ?", id).map(
      (r) => r.state,
    );
  const revoked = (id: string) =>
    q<{ revoked: number }>("SELECT revoked FROM agent_registry WHERE motebit_id = ?", id)[0]!
      .revoked;

  const doors = [
    { name: "cancel", method: "POST", path: "migrate/cancel", after: "cancelled" },
    { name: "depart", method: "POST", path: "migrate/depart", after: "departed" },
    { name: "attestation", method: "GET", path: "migration/attestation", after: "attesting" },
    { name: "export", method: "GET", path: "migration/export", after: "exporting" },
  ] as const;
  const call = (method: string, path: string, bearer: string | null) =>
    method === "GET" ? get(path, bearer) : post(path, bearer);

  for (const d of doors) {
    it(`${d.name}: another identity's token is refused 403, recorded — B's migration and registry unchanged`, async () => {
      const A = await ident("a-dev");
      const B = await ident("b-dev");
      await initiate(B);
      const res = await call(
        d.method,
        `/api/v1/agents/${B.id}/${d.path}`,
        await A.tok("admin:query"),
      );
      expect(res.status).toBe(403);
      expect(state(B.id)).toEqual(["initiated"]);
      expect(revoked(B.id)).toBe(0);
      expect(refusals(`migration:${d.name}`)).toEqual([
        {
          kind: "agent_token_rejected",
          motebit_id: A.id,
          reason: `migration:${d.name}:not_own_identity`,
          path: `/api/v1/agents/${B.id}/${d.path}`,
        },
      ]);
    });

    it(`${d.name}: no credential is refused — B's migration unchanged`, async () => {
      const B = await ident("b-dev");
      await initiate(B);
      const res = await call(d.method, `/api/v1/agents/${B.id}/${d.path}`, null);
      expect(res.status).toBe(401);
      expect(state(B.id)).toEqual(["initiated"]);
      expect(missingTokenRows(`/api/v1/agents/${B.id}/${d.path}`)).toEqual([
        { kind: "agent_token_rejected", motebit_id: null, reason: "missing_token" },
      ]);
    });

    it(`${d.name}: the identity's own token is unchanged`, async () => {
      const B = await ident("b-dev");
      await initiate(B);
      const res = await call(
        d.method,
        `/api/v1/agents/${B.id}/${d.path}`,
        await B.tok("admin:query"),
      );
      expect(res.status).toBe(200);
      expect(state(B.id)).toEqual([d.after]);
      if (d.name === "depart") expect(revoked(B.id)).toBe(1);
    });
  }

  it("the operator's master token still departs an identity", async () => {
    const B = await ident("b-dev");
    await initiate(B);
    const res = await post(`/api/v1/agents/${B.id}/migrate/depart`, "test-token");
    expect(res.status).toBe(200);
    expect(state(B.id)).toEqual(["departed"]);
  });
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

describe("approval requests are filed only by their own identity", () => {
  const body = (approver: string) => ({
    approval_id: "appr-" + crypto.randomUUID(),
    tool_name: "t",
    args_hash: "h",
    quorum_required: 1,
    quorum_approvers: [approver],
  });
  const rows = (id: string) =>
    q<{ n: number }>(
      "SELECT COUNT(*) AS n FROM relay_approval_metadata WHERE motebit_id = ?",
      id,
    )[0]!.n;

  it("another identity's token is refused 403, recorded — no row filed under B", async () => {
    const A = await ident("a-dev");
    const B = await ident("b-dev");
    const res = await post(
      `/api/v1/agents/${B.id}/approvals`,
      await A.tok("admin:query"),
      body(A.id),
    );
    expect(res.status).toBe(403);
    expect(rows(B.id)).toBe(0);
    expect(refusals("approval:create")).toEqual([
      {
        kind: "agent_token_rejected",
        motebit_id: A.id,
        reason: "approval:create:not_own_identity",
        path: `/api/v1/agents/${B.id}/approvals`,
      },
    ]);
  });

  it("no credential is refused 401 — no row", async () => {
    const B = await ident("b-dev");
    const res = await post(`/api/v1/agents/${B.id}/approvals`, null, body(B.id));
    expect(res.status).toBe(401);
    expect(rows(B.id)).toBe(0);
    expect(missingTokenRows(`/api/v1/agents/${B.id}/approvals`)).toEqual([
      { kind: "agent_token_rejected", motebit_id: null, reason: "missing_token" },
    ]);
  });

  it("the identity's own token, and the operator's, are unchanged", async () => {
    const B = await ident("b-dev");
    expect(
      (await post(`/api/v1/agents/${B.id}/approvals`, await B.tok("admin:query"), body(B.id)))
        .status,
    ).toBe(200);
    expect((await post(`/api/v1/agents/${B.id}/approvals`, "test-token", body(B.id))).status).toBe(
      200,
    );
    expect(rows(B.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Found by the #846 v2 door audit
// ---------------------------------------------------------------------------

describe("dispute resolution is the operator's act", () => {
  const verdict = { resolution: "overturned", rationale: "r", fund_action: "refund_to_delegator" };
  const resolutions = () =>
    q<{ n: number }>("SELECT COUNT(*) AS n FROM relay_dispute_resolutions")[0]!.n;

  it("no credential is refused 401, recorded — no resolution written", async () => {
    const res = await post(`/api/v1/disputes/d-${crypto.randomUUID()}/resolve`, null, verdict);
    expect(res.status).toBe(401);
    expect(resolutions()).toBe(0);
    expect(refusals("dispute:resolve")).toEqual([
      expect.objectContaining({ motebit_id: null, reason: "dispute:resolve:unauthenticated" }),
    ]);
  });

  it("an identity's device token is refused 403, recorded under that identity", async () => {
    const A = await ident("a-dev");
    const res = await post(
      `/api/v1/disputes/d-${crypto.randomUUID()}/resolve`,
      await A.tok("admin:query"),
      verdict,
    );
    expect(res.status).toBe(403);
    expect(resolutions()).toBe(0);
    expect(refusals("dispute:resolve")).toEqual([
      expect.objectContaining({ motebit_id: A.id, reason: "dispute:resolve:operator_only" }),
    ]);
  });

  it("the operator's master token reaches the handler (an unknown dispute is its 404)", async () => {
    const res = await post(
      `/api/v1/disputes/d-${crypto.randomUUID()}/resolve`,
      "test-token",
      verdict,
    );
    expect(res.status).toBe(404);
    expect(refusals("dispute:resolve")).toEqual([]);
  });
});

describe("a proposal step result belongs to the participant who reported it", () => {
  async function proposal(initiator: Ident, others: Ident[]): Promise<string> {
    const id = "prop-" + crypto.randomUUID();
    const res = await post("/api/v1/proposals", await initiator.tok("proposal"), {
      proposal_id: id,
      plan_id: "plan-" + id,
      participants: [initiator, ...others].map((p, i) => ({
        motebit_id: p.id,
        assigned_steps: [i],
      })),
    });
    expect(res.status).toBeLessThan(300);
    return id;
  }
  const result = (pid: string, sid: string) =>
    q<{ motebit_id: string; status: string }>(
      "SELECT motebit_id, status FROM relay_collaborative_step_results WHERE proposal_id = ? AND step_id = ?",
      pid,
      sid,
    );

  it("another participant cannot overwrite it: 409, recorded, row unchanged", async () => {
    const A = await ident("a-dev");
    const B = await ident("b-dev");
    const pid = await proposal(A, [B]);
    const own = await post(`/api/v1/proposals/${pid}/step-result`, await B.tok("proposal"), {
      step_id: "s1",
      status: "completed",
    });
    expect(own.status).toBe(200);
    const res = await post(`/api/v1/proposals/${pid}/step-result`, await A.tok("proposal"), {
      step_id: "s1",
      status: "failed",
    });
    expect(res.status).toBe(409);
    expect(result(pid, "s1")).toEqual([{ motebit_id: B.id, status: "completed" }]);
    expect(refusals("proposal:step_result_held_by_another")).toEqual([
      expect.objectContaining({ motebit_id: A.id }),
    ]);
  });

  it("the participant who reported it can update it", async () => {
    const A = await ident("a-dev");
    const B = await ident("b-dev");
    const pid = await proposal(A, [B]);
    const tok = await B.tok("proposal");
    await post(`/api/v1/proposals/${pid}/step-result`, tok, { step_id: "s1", status: "running" });
    const res = await post(`/api/v1/proposals/${pid}/step-result`, tok, {
      step_id: "s1",
      status: "completed",
    });
    expect(res.status).toBe(200);
    expect(result(pid, "s1")).toEqual([{ motebit_id: B.id, status: "completed" }]);
  });
});

describe("the unauthenticated subscription status read writes nothing", () => {
  it("creates no account row for the id it is asked about", async () => {
    const id = crypto.randomUUID();
    const res = await get(`/api/v1/subscriptions/${id}/status`, null);
    expect(res.status).toBe(200);
    expect(
      q<{ n: number }>("SELECT COUNT(*) AS n FROM relay_accounts WHERE motebit_id = ?", id)[0]!.n,
    ).toBe(0);
  });
});
