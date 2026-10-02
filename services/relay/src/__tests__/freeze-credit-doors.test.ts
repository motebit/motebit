/**
 * The freeze at the money chokepoint, seen from the two credit doors that are
 * not webhooks: the proxy-token mint's one-time free credit and the checkout
 * return's `session-status` activation.
 *
 * Each door is reached past the freeze middleware's entry check — the mint
 * while its caller's token is verified (the freeze lands in that await), the
 * session-status read because it is a GET (never entry-checked) and while it
 * awaits Stripe. The guards refuse the credit at the write; the door must say
 * so (never a silent 2xx that drops the credit, never a partial write), and the
 * credit must land exactly once after unfreeze.
 *
 * Real routes, the real admin freeze/unfreeze routes, a Stripe client whose
 * `checkout.sessions.retrieve` answers from the test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { createTestRelay, JSON_AUTH, API_TOKEN } from "./test-helpers.js";
import { getAccountBalance, toMicro } from "../accounts.js";
// eslint-disable-next-line no-restricted-imports -- test needs direct crypto
import { generateKeypair, bytesToHex } from "@motebit/crypto";
// eslint-disable-next-line no-restricted-imports -- test mints its own bearer token
import { createSignedToken } from "@motebit/encryption";

const hook = vi.hoisted(() => ({
  /** The caller-token verification await (after the freeze entry check). */
  beforeVerifyToken: null as null | (() => Promise<void>),
  /** Stripe's `checkout.sessions.retrieve`, answered by the test. */
  retrieve: null as null | ((id: string) => Promise<unknown>),
}));
vi.mock("@motebit/encryption", async (importOriginal) => {
  const m = await importOriginal<typeof import("@motebit/encryption")>();
  const verifySignedToken: typeof m.verifySignedToken = async (...a) => {
    const before = hook.beforeVerifyToken;
    if (before != null) {
      hook.beforeVerifyToken = null;
      await before();
    }
    return m.verifySignedToken(...a);
  };
  return { ...m, verifySignedToken };
});
vi.mock("stripe", async (importOriginal) => {
  const m = await importOriginal<{ default: new (...a: never[]) => object }>();
  const Real = m.default;
  class TestStripe extends Real {
    constructor(...a: never[]) {
      super(...a);
      const self = this as unknown as {
        checkout: { sessions: { retrieve: (id: string) => Promise<unknown> } };
      };
      self.checkout.sessions.retrieve = (id: string) => {
        if (hook.retrieve == null) throw new Error("no retrieve stub");
        return hook.retrieve(id);
      };
    }
  }
  return { ...m, default: TestStripe };
});

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  hook.beforeVerifyToken = null;
  hook.retrieve = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  hook.beforeVerifyToken = null;
  hook.retrieve = null;
  vi.restoreAllMocks();
});

async function freeze(relay: SyncRelay): Promise<void> {
  const res = await relay.app.request("/api/v1/admin/freeze", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ reason: "freeze-credit-doors" }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}
async function unfreeze(relay: SyncRelay): Promise<void> {
  const res = await relay.app.request("/api/v1/admin/unfreeze", {
    method: "POST",
    headers: JSON_AUTH,
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

const balance = (relay: SyncRelay, id: string): number =>
  getAccountBalance(relay.moteDb.db, id)?.balance ?? 0;
const txCount = (relay: SyncRelay, ref: string): number =>
  (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_transactions WHERE reference_id = ?")
      .get(ref) as { n: number }
  ).n;

// ── Free credit at the proxy-token mint ─────────────────────────────────────

/** An identity + device and a proxy:token-audience bearer for it. */
async function agentWithProxyToken(
  relay: SyncRelay,
): Promise<{ motebitId: string; mint: () => Promise<Response> }> {
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
  const mint = async (): Promise<Response> => {
    const token = await createSignedToken(
      {
        mid: motebit_id,
        did: device_id,
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud: "proxy:token",
      },
      kp.privateKey,
    );
    return relay.app.request(`/api/v1/agents/${motebit_id}/proxy-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  };
  return { motebitId: motebit_id, mint };
}

describe("proxy-token free credit — a freeze landing after the entry check", () => {
  let relay: SyncRelay;
  // The mint refuses (503) without the debit secret its tokens' debits need.
  const prevProxySecret = process.env.RELAY_PROXY_SECRET;
  beforeEach(async () => {
    process.env.MOTEBIT_FREE_CREDIT_USD = "0.50";
    process.env.RELAY_PROXY_SECRET ??= "test-relay-proxy-secret";
    relay = await createTestRelay({ enableDeviceAuth: true, apiToken: API_TOKEN });
  });
  afterEach(async () => {
    delete process.env.MOTEBIT_FREE_CREDIT_USD;
    if (prevProxySecret === undefined) delete process.env.RELAY_PROXY_SECRET;
    else process.env.RELAY_PROXY_SECRET = prevProxySecret;
    await relay.close();
  });

  it("the token is minted with the credit stated as deferred (never a silent zero); the next mint grants it once", async () => {
    const { motebitId, mint } = await agentWithProxyToken(relay);
    const ref = `free-credit:${motebitId}`;

    hook.beforeVerifyToken = () => freeze(relay);
    const frozen = await mint();
    expect(hook.beforeVerifyToken, "the freeze landed after the entry check").toBeNull();
    expect(frozen.status, await frozen.clone().text()).toBe(200);
    const fb = (await frozen.json()) as {
      balance: number;
      free_credit?: { status: string; reason: string };
    };
    expect(fb.balance).toBe(0);
    expect(fb.free_credit, "the body states the credit was deferred").toEqual({
      status: "deferred",
      reason: "EMERGENCY_FROZEN",
    });
    expect(txCount(relay, ref), "FROZEN: no grant").toBe(0);
    expect(
      relay.moteDb.db.prepare("SELECT COUNT(*) AS n FROM relay_free_grants").get(),
      "FROZEN: no per-IP grant counted",
    ).toEqual({ n: 0 });

    await unfreeze(relay);
    const next = await mint();
    expect(next.status).toBe(200);
    const nb = (await next.json()) as { balance: number; free_credit?: unknown };
    expect(nb.balance, "RESUME: granted on the next mint").toBe(toMicro(0.5));
    expect(nb.free_credit, "nothing deferred any more").toBeUndefined();
    await mint();
    expect(txCount(relay, ref), "granted once").toBe(1);
    expect(balance(relay, motebitId), "never twice").toBe(toMicro(0.5));
  });
});

// ── session-status: the checkout-return activation ──────────────────────────

function paidSession(motebitId: string, subId: string) {
  return {
    id: `cs_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    metadata: { motebit_id: motebitId },
    subscription: subId,
    customer: "cus_fz_status",
    customer_details: { email: "Status@Example.com" },
  };
}

describe("GET /api/v1/subscriptions/session-status — while frozen", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_freeze_session_status";
    relay = await createTestRelay({ enableDeviceAuth: false });
  });
  afterEach(async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await relay.close();
  });

  const subRow = (motebitId: string): unknown =>
    relay.moteDb.db
      .prepare("SELECT status FROM relay_subscriptions WHERE motebit_id = ?")
      .get(motebitId);
  const status = (sessionId: string) =>
    relay.app.request(`/api/v1/subscriptions/session-status?session_id=${sessionId}`, {
      method: "GET",
    });

  for (const when of ["before the request", "during the Stripe read"] as const) {
    it(`a freeze landing ${when}: 503 EMERGENCY_FROZEN, no subscription row and no credit; the replay after unfreeze activates and credits once`, async () => {
      const motebitId = `m-status-${crypto.randomUUID()}`;
      const subId = `sub_${crypto.randomUUID().replace(/-/g, "")}`;
      const session = paidSession(motebitId, subId);
      let landedInRead = false;
      hook.retrieve = async () => {
        if (when === "during the Stripe read" && !landedInRead) {
          landedInRead = true;
          await settle(1);
          await freeze(relay);
        }
        return session;
      };
      if (when === "before the request") await freeze(relay);

      const frozen = await status(session.id);
      expect(frozen.status, await frozen.clone().text()).toBe(503);
      expect(((await frozen.json()) as { code?: string }).code).toBe("EMERGENCY_FROZEN");
      if (when === "during the Stripe read") expect(landedInRead).toBe(true);
      expect(subRow(motebitId), "FROZEN: no partial subscription row").toBeUndefined();
      expect(txCount(relay, `sub:${subId}:initial`), "FROZEN: no credit").toBe(0);

      await unfreeze(relay);
      const ok = await status(session.id);
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect(subRow(motebitId)).toEqual({ status: "active" });
      expect(balance(relay, motebitId), "RESUME: credited once").toBe(toMicro(20));
      expect((await status(session.id)).status).toBe(200);
      expect(txCount(relay, `sub:${subId}:initial`), "never twice").toBe(1);
      expect(balance(relay, motebitId)).toBe(toMicro(20));
    });
  }
});
