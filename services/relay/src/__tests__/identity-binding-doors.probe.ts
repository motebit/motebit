/**
 * #846 v2 differential probe — the non-sync doors, cross-identity /
 * unauthenticated / own-identity / operator, over HTTP only, so the SAME file
 * runs against the branch and against origin/main
 * (`scripts/differential-vs-main.ts`). Only the cross-identity and
 * unauthenticated cells are meant to differ.
 */
import { it, beforeAll, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
import {
  generateKeypair,
  bytesToHex,
  mintAudienceToken,
  signMigrationRequest,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay, signedBootstrapBody } from "./test-helpers.js";

const stripeCalls: unknown[] = [];
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
const obs: Record<string, unknown> = {};
beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_probe";
  relay = await createTestRelay();
});
afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  await relay.close();
});

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
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: id,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["x"],
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  return {
    id,
    kp,
    tok: async (aud) =>
      (await mintAudienceToken({ mid: id, did: device, aud }, kp.privateKey)).token,
  };
}
const q = (sql: string, ...a: unknown[]) => relay.moteDb.db.prepare(sql).all(...a) as unknown[];
const req = (method: string, path: string, bearer: string | null, body?: unknown) =>
  relay.app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(bearer != null ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

it("observes the non-sync doors", async () => {
  const who = { A: await ident("a"), B: await ident("b") };
  const bearer = async (cell: string, aud: string): Promise<string | null> =>
    cell === "none"
      ? null
      : cell === "cross"
        ? who.A.tok(aud)
        : cell === "own"
          ? who.B.tok(aud)
          : "test-token";
  const CELLS = ["none", "cross", "own", "operator"] as const;

  // Subscriptions
  for (const [route, from] of [
    ["cancel", "active"],
    ["resubscribe", "cancelling"],
  ] as const) {
    for (const cell of CELLS) {
      const id = who.B.id;
      relay.moteDb.db.prepare("DELETE FROM relay_subscriptions WHERE motebit_id = ?").run(id);
      relay.moteDb.db
        .prepare(
          "INSERT INTO relay_subscriptions (motebit_id, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at) VALUES (?, 'cus', 'sub', ?, 1, 1)",
        )
        .run(id, from);
      const before = stripeCalls.length;
      const res = await req(
        "POST",
        `/api/v1/subscriptions/${id}/${route}`,
        await bearer(cell, "account:checkout"),
      );
      obs[`subscriptions ${route} ${cell}`] = {
        status: res.status,
        row: q("SELECT status FROM relay_subscriptions WHERE motebit_id = ?", id),
        stripe_called: stripeCalls.length > before,
      };
    }
  }

  // Migration: fresh identity per cell (depart is terminal)
  for (const [name, method, path] of [
    ["cancel", "POST", "migrate/cancel"],
    ["depart", "POST", "migrate/depart"],
    ["attestation", "GET", "migration/attestation"],
    ["export", "GET", "migration/export"],
  ] as const) {
    for (const cell of CELLS) {
      who.B = await ident("b");
      const signed = await signMigrationRequest(
        {
          motebit_id: who.B.id,
          reason: "r",
          requested_at: Date.now(),
          suite: "motebit-jcs-ed25519-b64-v1",
        } as never,
        who.B.kp.privateKey,
      );
      await req(
        "POST",
        `/api/v1/agents/${who.B.id}/migrate`,
        await who.B.tok("admin:query"),
        signed,
      );
      const res = await req(
        method,
        `/api/v1/agents/${who.B.id}/${path}`,
        await bearer(cell, "admin:query"),
      );
      obs[`migration ${name} ${cell}`] = {
        status: res.status,
        states: q("SELECT state FROM relay_migrations WHERE motebit_id = ?", who.B.id),
        revoked: q("SELECT revoked FROM agent_registry WHERE motebit_id = ?", who.B.id),
      };
    }
  }

  // Approvals
  for (const cell of CELLS) {
    who.B = await ident("b");
    const res = await req(
      "POST",
      `/api/v1/agents/${who.B.id}/approvals`,
      await bearer(cell, "admin:query"),
      {
        approval_id: "ap-" + crypto.randomUUID(),
        tool_name: "t",
        args_hash: "h",
        quorum_required: 1,
        quorum_approvers: [who.A.id],
      },
    );
    obs[`approvals create ${cell}`] = {
      status: res.status,
      rows_under_B: q(
        "SELECT COUNT(*) AS n FROM relay_approval_metadata WHERE motebit_id = ?",
        who.B.id,
      ),
    };
  }

  // Dispute resolve (no dispute: auth decides before the handler's 404)
  for (const cell of CELLS) {
    const res = await req(
      "POST",
      `/api/v1/disputes/d-${crypto.randomUUID()}/resolve`,
      await bearer(cell, "admin:query"),
      { resolution: "overturned", rationale: "r", fund_action: "refund_to_delegator" },
    );
    obs[`dispute resolve ${cell}`] = { status: res.status };
  }

  // Proposal step result: B reports s1, then A (a participant) overwrites
  {
    const pid = "prop-" + crypto.randomUUID();
    await req("POST", "/api/v1/proposals", await who.A.tok("proposal"), {
      proposal_id: pid,
      plan_id: "plan",
      participants: [
        { motebit_id: who.A.id, assigned_steps: [0] },
        { motebit_id: who.B.id, assigned_steps: [1] },
      ],
    });
    await req("POST", `/api/v1/proposals/${pid}/step-result`, await who.B.tok("proposal"), {
      step_id: "s1",
      status: "completed",
    });
    const res = await req(
      "POST",
      `/api/v1/proposals/${pid}/step-result`,
      await who.A.tok("proposal"),
      {
        step_id: "s1",
        status: "failed",
      },
    );
    obs["proposal step-result overwrite by another participant"] = {
      status: res.status,
      row_owner_is_B: (
        q(
          "SELECT motebit_id FROM relay_collaborative_step_results WHERE proposal_id = ?",
          pid,
        ) as Array<{
          motebit_id: string;
        }>
      ).map((r) => r.motebit_id === who.B.id),
    };
  }

  // Subscription status: an unauthenticated read
  {
    const id = crypto.randomUUID();
    const res = await req("GET", `/api/v1/subscriptions/${id}/status`, null);
    obs["subscriptions status (unauthenticated read)"] = {
      status: res.status,
      account_rows_created: q("SELECT COUNT(*) AS n FROM relay_accounts WHERE motebit_id = ?", id),
    };
  }
});
