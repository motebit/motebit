/**
 * #853 — the identity an auth check binds must be the identity the handler
 * acts on. The `/sync/*` device auth bound its token to the RAW path segment
 * while the handlers read Hono's DECODED param, so an identity whose id was
 * `%37f3…` (a percent-encoding of the victim's `7f3…`) read and wrote the
 * victim's events and conversations with its own token.
 *
 * Two layers, each tested with the other still in place:
 *   1. Canonical ids at every door that writes an identity or device id
 *      (`refuseInvalidIds`): an id outside `[0-9A-Za-z_-]` cannot be created.
 *   2. Every guard that reads an identity from the raw path refuses a
 *      segment that is not literal (`pathIdentity`). Tested against an
 *      identity seeded directly — one an earlier relay admitted — so layer 1
 *      cannot be what refuses it.
 *
 * Plus a sibling the audit found: `/agent/*\/task` skipped authentication
 * when the raw URL — query string included — contained `/result`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  bytesToHex,
  generateKeypair,
  mintAudienceToken,
  signDeviceRegistration,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import { AUTH_HEADER, createTestRelay, keyProof } from "./test-helpers.js";
import { CANONICAL_ID_PATTERN, pathIdentity, refuseInvalidIds } from "../id-bounds.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** The attacker's id: the victim's first character percent-encoded. */
const encodedSpellingOf = (id: string) =>
  "%" + id.charCodeAt(0).toString(16).toUpperCase() + id.slice(1);

const ev = (mid: string, eventId: string, clock = 1) => ({
  event_id: eventId,
  motebit_id: mid,
  timestamp: Date.now(),
  event_type: "memory_formed",
  payload: { content: "x", sensitivity: "none" },
  version_clock: clock,
  tombstoned: false,
});

const conv = (mid: string, id: string, lastActive: number, count: number) => ({
  conversation_id: id,
  motebit_id: mid,
  started_at: 1,
  last_active_at: lastActive,
  title: null,
  summary: null,
  message_count: count,
});

describe("#853 the pure halves", () => {
  it("CANONICAL_ID_PATTERN admits what clients mint and nothing a decoder changes", () => {
    for (const id of [
      crypto.randomUUID(),
      "019280f2-7c1a-7d3e-8a4b-0c1d2e3f4a5b",
      "bootstrap-device",
      "mobile-local",
      "research_service",
    ]) {
      expect(CANONICAL_ID_PATTERN.test(id)).toBe(true);
      expect(encodeURIComponent(id)).toBe(id);
    }
    for (const id of ["%37f3", "a/b", "a b", "a:b", "a.b", "..", "a?b", "a#b", "ä", ""]) {
      expect(CANONICAL_ID_PATTERN.test(id)).toBe(false);
    }
  });

  it("refuseInvalidIds refuses a non-canonical motebit_id or device_id, and leaves empty to the door", () => {
    expect(refuseInvalidIds({ motebitId: "%37f3" })).toMatchObject({
      code: "ID_NOT_CANONICAL",
      field: "motebit_id",
    });
    expect(refuseInvalidIds({ deviceId: "x/y" })).toMatchObject({
      code: "ID_NOT_CANONICAL",
      field: "device_id",
    });
    expect(refuseInvalidIds({ motebitId: crypto.randomUUID(), deviceId: "cli_1" })).toBeNull();
    expect(refuseInvalidIds({ motebitId: "" })).toBeNull();
  });

  it("pathIdentity passes a literal segment and refuses any percent-encoding", () => {
    const id = crypto.randomUUID();
    expect(pathIdentity(id)).toBe(id);
    expect(pathIdentity(encodedSpellingOf(id))).toBeNull();
    expect(pathIdentity("a%3Ab")).toBeNull();
    expect(pathIdentity("%25")).toBeNull();
  });
});

describe("#853 through the relay", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  const req = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    relay.app.request(path, {
      method,
      headers: { ...JSON_HEADERS, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const bootstrap = async (motebitId: string, deviceId: string, kp: KeyPair) =>
    req(
      "POST",
      "/api/v1/agents/bootstrap",
      await keyProof(
        { motebit_id: motebitId, device_id: deviceId, public_key: bytesToHex(kp.publicKey) },
        kp.privateKey,
      ),
    );

  /** An identity + device row written directly — one an earlier relay admitted. */
  function seedHeld(motebitId: string, deviceId: string, kp: KeyPair) {
    relay.moteDb.db
      .prepare(
        "INSERT INTO identities (motebit_id, owner_id, created_at, version_clock) VALUES (?, ?, ?, 0)",
      )
      .run(motebitId, motebitId, Date.now());
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(deviceId, motebitId, crypto.randomUUID(), bytesToHex(kp.publicKey), Date.now());
  }

  const syncAuth = async (mid: string, did: string, kp: KeyPair) => ({
    Authorization: `Bearer ${(await mintAudienceToken({ mid, did, aud: "sync" }, kp.privateKey)).token}`,
  });

  const rows = (sql: string, ...args: unknown[]) =>
    relay.moteDb.db.prepare(sql).all(...args) as Record<string, unknown>[];

  // ── Layer 1: no door creates a non-canonical id ──

  describe("layer 1 — the doors", () => {
    const TABLES = ["identities", "devices", "agent_registry", "relay_push_tokens"];
    const counts = () =>
      TABLES.map(
        (t) => (relay.moteDb.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      );

    it("bootstrap refuses the encoded spelling of a held id, and writes nothing", async () => {
      const v = crypto.randomUUID();
      expect((await bootstrap(v, "v-laptop", await generateKeypair())).status).toBe(201);
      const before = counts();
      const res = await bootstrap(encodedSpellingOf(v), "x-laptop", await generateKeypair());
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("motebit_id may contain only");
      expect(counts()).toEqual(before);
    });

    it("bootstrap refuses a non-canonical device_id", async () => {
      const before = counts();
      const res = await bootstrap(crypto.randomUUID(), "x%2Fy", await generateKeypair());
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("device_id may contain only");
      expect(counts()).toEqual(before);
    });

    const registerSelf = async (motebitId: string, deviceId: string, kp: KeyPair) =>
      req(
        "POST",
        "/api/v1/devices/register-self",
        await signDeviceRegistration(
          {
            motebit_id: motebitId,
            device_id: deviceId,
            public_key: bytesToHex(kp.publicKey),
            timestamp: Date.now(),
          },
          kp.privateKey,
        ),
      );

    it("register-self refuses a validly signed non-canonical id as id_not_canonical", async () => {
      const before = counts();
      for (const [mid, did] of [
        [encodedSpellingOf(crypto.randomUUID()), crypto.randomUUID()],
        [crypto.randomUUID(), "d%41"],
      ] as const) {
        const res = await registerSelf(mid, did, await generateKeypair());
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          code: "DEVICE_REGISTRATION_REJECTED",
          reason: "id_not_canonical",
        });
      }
      expect(counts()).toEqual(before);
    });

    it("register-self still admits a canonical registration", async () => {
      const res = await registerSelf(
        crypto.randomUUID(),
        crypto.randomUUID(),
        await generateKeypair(),
      );
      expect(res.status).toBe(201);
    });

    it("/agents/register refuses a non-canonical motebit_id and records the refusal", async () => {
      const before = counts();
      const res = await req(
        "POST",
        "/api/v1/agents/register",
        {
          motebit_id: "a%3Ab",
          endpoint_url: "http://127.0.0.1:9/mcp",
          capabilities: ["x"],
        },
        AUTH_HEADER,
      );
      expect(res.status).toBe(400);
      expect(counts()).toEqual(before);
      expect(
        rows("SELECT reason FROM relay_auth_events WHERE reason = 'register:id_not_canonical'"),
      ).toHaveLength(1);
    });

    it("/device/register refuses a non-canonical held id a new device", async () => {
      const mid = encodedSpellingOf(crypto.randomUUID());
      seedHeld(mid, crypto.randomUUID(), await generateKeypair());
      const before = counts();
      const res = await req("POST", "/device/register", { motebit_id: mid }, AUTH_HEADER);
      expect(res.status).toBe(400);
      expect(counts()).toEqual(before);
    });

    it("push-token refuses a non-canonical device_id", async () => {
      const kp = await generateKeypair();
      const mid = crypto.randomUUID();
      const did = crypto.randomUUID();
      expect((await bootstrap(mid, did, kp)).status).toBe(201);
      const { token } = await mintAudienceToken({ mid, did, aud: "push:register" }, kp.privateKey);
      const res = await req(
        "POST",
        "/api/v1/agents/push-token",
        { device_id: "d/e", push_token: "t", platform: "expo" },
        { Authorization: `Bearer ${token}` },
      );
      expect(res.status).toBe(400);
      expect(rows("SELECT 1 FROM relay_push_tokens")).toHaveLength(0);
    });

    it("migration arrival refuses a non-canonical motebit_id before anything else", async () => {
      const res = await req(
        "POST",
        "/api/v1/agents/accept-migration",
        {
          motebit_id: encodedSpellingOf(crypto.randomUUID()),
          public_key: "00".repeat(32),
          migration_token: {},
          departure_attestation: {},
          credential_bundle: {},
        },
        AUTH_HEADER,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("motebit_id may contain only");
    });

    it("pairing approve gives a non-canonical held id no new device", async () => {
      const kp = await generateKeypair();
      const mid = "a.b";
      const did = crypto.randomUUID();
      seedHeld(mid, did, kp);
      const { token } = await mintAudienceToken({ mid, did, aud: "device:auth" }, kp.privateKey);
      const auth = { Authorization: `Bearer ${token}` };
      const init = await req("POST", "/pairing/initiate", {}, auth);
      expect(init.status).toBe(201);
      const { pairing_id, pairing_code } = (await init.json()) as {
        pairing_id: string;
        pairing_code: string;
      };
      const b = await generateKeypair();
      const claim = await req("POST", "/pairing/claim", {
        pairing_code,
        device_name: "phone",
        public_key: bytesToHex(b.publicKey),
      });
      expect(claim.status).toBe(200);
      const res = await req("POST", `/pairing/${pairing_id}/approve`, {}, auth);
      expect(res.status).toBe(400);
      expect(rows("SELECT 1 FROM devices WHERE motebit_id = ?", mid)).toHaveLength(1);
    });
  });

  // ── Layer 2: the /sync/* guard binds the identity the handler serves ──

  describe("layer 2 — /sync/* with an attacker identity an earlier relay admitted", () => {
    let V: { id: string; auth: Record<string, string> };
    let X: { id: string; auth: Record<string, string> };
    const CONV = "conv-853";

    beforeEach(async () => {
      const vk = await generateKeypair();
      const vid = crypto.randomUUID();
      expect((await bootstrap(vid, "v-laptop", vk)).status).toBe(201);
      V = { id: vid, auth: await syncAuth(vid, "v-laptop", vk) };
      const xk = await generateKeypair();
      const xid = encodedSpellingOf(vid);
      seedHeld(xid, "x-laptop", xk);
      X = { id: xid, auth: await syncAuth(xid, "x-laptop", xk) };
      const seeded = await req(
        "POST",
        `/sync/${V.id}/conversations`,
        { conversations: [conv(V.id, CONV, 1000, 1)] },
        V.auth,
      );
      expect(seeded.status).toBe(200);
      const pushed = await req(
        "POST",
        `/sync/${V.id}/push`,
        { events: [ev(V.id, "v-own")] },
        V.auth,
      );
      expect(pushed.status).toBe(200);
    });

    const expectRefusedAndRecorded = async (res: Response) => {
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("must be literal");
      const recorded = rows(
        "SELECT motebit_id, audience FROM relay_auth_events WHERE reason = 'path_id_not_literal'",
      );
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.at(-1)).toEqual({ motebit_id: X.id, audience: "sync" });
    };

    it("push naming the victim is refused and writes nothing", async () => {
      await expectRefusedAndRecorded(
        await req("POST", `/sync/${X.id}/push`, { events: [ev(V.id, "evil-push")] }, X.auth),
      );
      expect(rows("SELECT 1 FROM events WHERE event_id = 'evil-push'")).toHaveLength(0);
    });

    it("conversations POST cannot overwrite the victim's row", async () => {
      await expectRefusedAndRecorded(
        await req(
          "POST",
          `/sync/${X.id}/conversations`,
          { conversations: [conv(V.id, CONV, 9_999_999, 777)] },
          X.auth,
        ),
      );
      expect(
        rows(
          "SELECT motebit_id, last_active_at, message_count FROM sync_conversations WHERE conversation_id = ?",
          CONV,
        ),
      ).toEqual([{ motebit_id: V.id, last_active_at: 1000, message_count: 1 }]);
    });

    for (const path of [
      "pull?after_clock=0",
      "clock",
      "conversations",
      "messages?conversation_id=conv-853",
      "plans",
      "plan-steps",
    ]) {
      it(`GET ${path.split("?")[0]} does not read the victim`, async () => {
        const res = await req("GET", `/sync/${X.id}/${path}`, undefined, X.auth);
        const text = await res.clone().text();
        expect(text).not.toContain("v-own");
        expect(text).not.toContain(CONV);
        await expectRefusedAndRecorded(res);
      });
    }

    for (const kind of ["messages", "plans", "plan-steps"]) {
      it(`POST ${kind} is refused`, async () => {
        await expectRefusedAndRecorded(
          await req("POST", `/sync/${X.id}/${kind}`, { [kind]: [] }, X.auth),
        );
      });
    }

    it("the victim's own sync is unchanged: push, pull, conversations, clock", async () => {
      const push = await req(
        "POST",
        `/sync/${V.id}/push`,
        { events: [ev(V.id, "v-2", 2)] },
        V.auth,
      );
      expect(push.status).toBe(200);
      const pull = await req("GET", `/sync/${V.id}/pull?after_clock=0`, undefined, V.auth);
      expect(pull.status).toBe(200);
      const pulled = await pull.text();
      expect(pulled).toContain("v-own");
      expect(pulled).toContain("v-2");
      const convs = await req("GET", `/sync/${V.id}/conversations`, undefined, V.auth);
      expect(convs.status).toBe(200);
      expect(await convs.text()).toContain(CONV);
      expect((await req("GET", `/sync/${V.id}/clock`, undefined, V.auth)).status).toBe(200);
    });

    it("a second device of the victim syncs the same identity", async () => {
      const k2 = await generateKeypair();
      // A second key for a held identity arrives through pairing; this is
      // the device row an approved pairing writes.
      seedDevice(V.id, "v-phone", k2);
      const auth2 = await syncAuth(V.id, "v-phone", k2);
      const pull = await req("GET", `/sync/${V.id}/pull?after_clock=0`, undefined, auth2);
      expect(pull.status).toBe(200);
      expect(await pull.text()).toContain("v-own");
      const push = await req(
        "POST",
        `/sync/${V.id}/push`,
        { events: [ev(V.id, "v-phone-1", 3)] },
        auth2,
      );
      expect(push.status).toBe(200);
    });

    function seedDevice(motebitId: string, deviceId: string, kp: KeyPair) {
      relay.moteDb.db
        .prepare(
          "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(deviceId, motebitId, crypto.randomUUID(), bytesToHex(kp.publicKey), Date.now());
    }

    it("the master token still reaches any identity's sync", async () => {
      const res = await req("GET", `/sync/${V.id}/pull?after_clock=0`, undefined, AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("v-own");
    });

    it("the attacker's plain token on the victim's plain path is refused (control)", async () => {
      const res = await req("POST", `/sync/${V.id}/push`, { events: [ev(V.id, "ctl")] }, X.auth);
      expect(res.status).toBe(403);
    });
  });

  // ── Sibling: /agent/*/task decided its auth skip on the raw URL ──

  describe("/agent/:id/task — the /result skip reads the routed path", () => {
    const submit = (path: string) =>
      req("POST", path, { prompt: "hi" }, { "Idempotency-Key": crypto.randomUUID() });

    it("a query string naming /result does not skip authentication", async () => {
      const id = crypto.randomUUID();
      const res = await submit(`/agent/${id}/task?x=/result`);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("task_id");
    });

    it("the x402 gate refuses a path id its decoder and the handler's disagree about", async () => {
      // `c.req.path` keeps `%3A` (decodeURI); the handler's param reads `:`
      // (decodeURIComponent). The gate priced `a%3Ab` — never listed, so
      // free — while the handler served `a:b`.
      relay.moteDb.db
        .prepare(
          "INSERT INTO relay_service_listings (listing_id, motebit_id, capabilities, pricing, pay_to_address, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          crypto.randomUUID(),
          "a:b",
          JSON.stringify(["x"]),
          JSON.stringify([{ capability: "x", unit_cost: 1, currency: "USD", per: "task" }]),
          "0x0000000000000000000000000000000000000001",
          Date.now(),
        );
      const res = await req(
        "POST",
        "/agent/a%3Ab/task",
        { prompt: "hi" },
        { ...AUTH_HEADER, "Idempotency-Key": crypto.randomUUID() },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("must be literal");
    });

    it("an unauthenticated plain submission is refused (control)", async () => {
      expect((await submit(`/agent/${crypto.randomUUID()}/task`)).status).toBe(401);
    });

    it("the /result route still takes its own task:result auth, not the submit audience", async () => {
      const kp = await generateKeypair();
      const id = crypto.randomUUID();
      expect((await bootstrap(id, "w", kp)).status).toBe(201);
      const { token } = await mintAudienceToken(
        { mid: id, did: "w", aud: "task:result" },
        kp.privateKey,
      );
      const res = await req(
        "POST",
        `/agent/${id}/task/${crypto.randomUUID()}/result`,
        {},
        { Authorization: `Bearer ${token}` },
      );
      // Past authentication: the handler judges the (empty) receipt.
      expect([401, 403]).not.toContain(res.status);
    });
  });
});
