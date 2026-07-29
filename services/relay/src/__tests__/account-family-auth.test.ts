/**
 * Account-family route auth (#460) — the regression lock for the
 * double-wrap audience conflict witnessed live 2026-07-29.
 *
 * Two auth layers wrap `/api/v1/agents/:id/{balance,withdraw,withdrawals,
 * checkout,settlements}`: the early agent-family middleware (agents.ts)
 * and the dedicated `dualAuth(account:*)` guards (middleware.ts). Before
 * this fix the family middleware fell through to its `admin:query`
 * default for the account routes, so the two layers demanded DIFFERENT
 * audiences of the same bearer — no device token could satisfy the
 * composition, and every sovereign `balance` read 401'd
 * (composition-preserves-enforcement, inverse flavor: each layer
 * individually correct, the composition severs the legitimate path).
 *
 * The audience fix also un-masks a second latent hole this suite locks:
 * the account handlers had no first-person own-id check, so once
 * account:* tokens could reach them, agent A could read agent B's
 * balance or POST a withdraw against B's account with a self-supplied
 * destination. Device tokens are now first-person; master token remains
 * the operator bypass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import { createTestRelay, JSON_AUTH, AUTH_HEADER, seedBalance } from "./test-helpers.js";

async function seedAgent(relay: SyncRelay): Promise<{
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}> {
  const kp = await generateKeypair();
  const idRes = await relay.app.request("/identity", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const { motebit_id } = (await idRes.json()) as { motebit_id: string };
  const devRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id, device_name: "T", public_key: bytesToHex(kp.publicKey) }),
  });
  const { device_id } = (await devRes.json()) as { device_id: string };
  return { motebitId: motebit_id, deviceId: device_id, privateKey: kp.privateKey };
}

async function mint(
  a: { motebitId: string; deviceId: string; privateKey: Uint8Array },
  aud: TokenAudience,
): Promise<string> {
  const { token } = await mintAudienceToken(
    { mid: a.motebitId, did: a.deviceId, aud },
    a.privateKey,
  );
  return token;
}

describe("account-family route auth (#460 double-wrap regression lock)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("GET /balance with the caller's own account:balance device token → 200 (the live #460 repro)", async () => {
    const agent = await seedAgent(relay);
    seedBalance(relay, agent.motebitId, 1);
    const token = await mint(agent, "account:balance");
    const res = await relay.app.request(`/api/v1/agents/${agent.motebitId}/balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; balance: number };
    expect(body.motebit_id).toBe(agent.motebitId);
    expect(body.balance).toBe(1);
  });

  it("GET /balance with an admin:query token → 401 (audience binding still enforced)", async () => {
    const agent = await seedAgent(relay);
    const token = await mint(agent, "admin:query");
    const res = await relay.app.request(`/api/v1/agents/${agent.motebitId}/balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("GET /balance for ANOTHER agent with a valid account:balance token → 403 (first-person)", async () => {
    const alice = await seedAgent(relay);
    const bob = await seedAgent(relay);
    seedBalance(relay, bob.motebitId, 5);
    const token = await mint(alice, "account:balance");
    const res = await relay.app.request(`/api/v1/agents/${bob.motebitId}/balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("POST /withdraw against ANOTHER agent's account → 403 (fund-drain lock)", async () => {
    const alice = await seedAgent(relay);
    const bob = await seedAgent(relay);
    seedBalance(relay, bob.motebitId, 5);
    const token = await mint(alice, "account:withdraw");
    const res = await relay.app.request(`/api/v1/agents/${bob.motebitId}/withdraw`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        amount: 5,
        destination: "AttackerAddr11111111111111111111111111111111",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /withdraw with the caller's own account:withdraw token passes both auth layers", async () => {
    const agent = await seedAgent(relay);
    seedBalance(relay, agent.motebitId, 5);
    const token = await mint(agent, "account:withdraw");
    const res = await relay.app.request(`/api/v1/agents/${agent.motebitId}/withdraw`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 1 }),
    });
    // Not 401/403 — auth composed; outcome depends on withdrawal rails.
    expect([200, 201, 402]).toContain(res.status);
  });

  it("GET /withdrawals own token → 200; other's → 403", async () => {
    const alice = await seedAgent(relay);
    const bob = await seedAgent(relay);
    const own = await relay.app.request(`/api/v1/agents/${alice.motebitId}/withdrawals`, {
      headers: { Authorization: `Bearer ${await mint(alice, "account:withdrawals")}` },
    });
    expect(own.status).toBe(200);
    const cross = await relay.app.request(`/api/v1/agents/${bob.motebitId}/withdrawals`, {
      headers: { Authorization: `Bearer ${await mint(alice, "account:withdrawals")}` },
    });
    expect(cross.status).toBe(403);
  });

  it("GET /settlements still requires auth after the carve-out removal", async () => {
    const agent = await seedAgent(relay);
    const anon = await relay.app.request(`/api/v1/agents/${agent.motebitId}/settlements`);
    expect(anon.status).toBe(401);
    const authed = await relay.app.request(`/api/v1/agents/${agent.motebitId}/settlements`, {
      headers: { Authorization: `Bearer ${await mint(agent, "account:balance")}` },
    });
    expect(authed.status).toBe(200);
  });

  it("master token still reads any balance (operator console bypass)", async () => {
    const agent = await seedAgent(relay);
    seedBalance(relay, agent.motebitId, 2);
    const res = await relay.app.request(`/api/v1/agents/${agent.motebitId}/balance`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
  });
});
