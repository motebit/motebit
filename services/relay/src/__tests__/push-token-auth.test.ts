/**
 * Push-token route auth (#825) — a phone's push token must reach
 * `relay_push_tokens`.
 *
 * Mobile (`apps/mobile/src/push-token-manager.ts`) registers with a device
 * token minted for `push:register` — the audience `@motebit/protocol` names
 * for push-notification token registration (`PUSH_REGISTER_AUDIENCE`). The
 * `/api/v1/agents/*` middleware (agents.ts) had no branch for the route, so
 * it fell through to its `admin:query` default: every phone's registration
 * 401'd, `relay_push_tokens` stayed empty, and wake-by-push could never
 * reach a phone. The same shape as #460 (balance) and #702 (rotate-key):
 * the client names an audience, the route defaults to another.
 *
 * The token here is minted EXACTLY as mobile mints it —
 * `MobileApp.createSyncToken` is `mintAudienceToken({ mid, did, aud },
 * privateKey)` — and the body is the one `registerPushToken` posts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import { PUSH_REGISTER_AUDIENCE, type TokenAudience } from "@motebit/protocol";
import { createTestRelay, JSON_AUTH } from "./test-helpers.js";

interface Agent {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}

async function seedAgent(relay: SyncRelay): Promise<Agent> {
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
    body: JSON.stringify({
      motebit_id,
      device_name: "phone",
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  const { device_id } = (await devRes.json()) as { device_id: string };
  return { motebitId: motebit_id, deviceId: device_id, privateKey: kp.privateKey };
}

/** Byte-for-byte the call `MobileApp.createSyncToken(aud)` makes. */
async function mintAsMobile(a: Agent, aud: TokenAudience): Promise<string> {
  return (await mintAudienceToken({ mid: a.motebitId, did: a.deviceId, aud }, a.privateKey)).token;
}

function register(relay: SyncRelay, a: Agent, token: string, pushToken: string) {
  return relay.app.request("/api/v1/agents/push-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ device_id: a.deviceId, push_token: pushToken, platform: "expo" }),
  });
}

function rowsFor(relay: SyncRelay, motebitId: string): Array<{ push_token: string }> {
  return relay.moteDb.db
    .prepare("SELECT push_token FROM relay_push_tokens WHERE motebit_id = ?")
    .all(motebitId) as Array<{ push_token: string }>;
}

describe("push-token route auth (#825)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("mobile names the protocol's push-registration audience", () => {
    expect(PUSH_REGISTER_AUDIENCE).toBe("push:register");
  });

  it("POST with a push:register token minted as mobile mints it → 200 and a stored row", async () => {
    const phone = await seedAgent(relay);
    const token = await mintAsMobile(phone, "push:register");
    const res = await register(relay, phone, token, "ExponentPushToken[abc]");
    expect(res.status).toBe(200);
    expect(rowsFor(relay, phone.motebitId)).toEqual([{ push_token: "ExponentPushToken[abc]" }]);
  });

  it("DELETE with a push:register token (mobile's removePushToken) → 200 and the row is gone", async () => {
    const phone = await seedAgent(relay);
    await register(
      relay,
      phone,
      await mintAsMobile(phone, "push:register"),
      "ExponentPushToken[x]",
    );
    const res = await relay.app.request("/api/v1/agents/push-token", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await mintAsMobile(phone, "push:register")}`,
      },
      body: JSON.stringify({ device_id: phone.deviceId }),
    });
    expect(res.status).toBe(200);
    expect(rowsFor(relay, phone.motebitId)).toEqual([]);
  });

  it.each<TokenAudience>(["admin:query", "sync", "device:auth", "account:balance"])(
    "a token for another audience (%s) is refused and stores nothing",
    async (aud) => {
      const phone = await seedAgent(relay);
      const res = await register(
        relay,
        phone,
        await mintAsMobile(phone, aud),
        "ExponentPushToken[y]",
      );
      expect(res.status).toBe(401);
      expect(rowsFor(relay, phone.motebitId)).toEqual([]);
    },
  );

  // Every other method on the push-token path is NOT a push-token route:
  // GET is `GET /api/v1/agents/:motebitId` with the id "push-token" (a
  // squattable id), and PUT/PATCH match no route. The branch is guarded to
  // POST/DELETE so these keep main's default `admin:query` exactly: a
  // push:register token must not reach them, and an admin:query token still
  // does, with main's status.
  function onPath(method: string, token: string) {
    return relay.app.request("/api/v1/agents/push-token", {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
  }

  it.each(["GET", "PUT", "PATCH"])(
    "%s on the push-token path refuses a push:register token (default audience, as main)",
    async (method) => {
      const phone = await seedAgent(relay);
      const res = await onPath(method, await mintAsMobile(phone, "push:register"));
      expect(res.status).toBe(401);
    },
  );

  it("GET on the push-token path still passes auth with an admin:query token (→ 404, as main)", async () => {
    const phone = await seedAgent(relay);
    const res = await onPath("GET", await mintAsMobile(phone, "admin:query"));
    expect(res.status).toBe(404);
  });

  // PUT and PATCH match no route on this path, so the /api/v1/* catch-all
  // carves out neither (#855: a carve-out is one method on one registered
  // route) and they are master-only — refused before the agent middleware.
  it.each(["PUT", "PATCH"])(
    "%s on the push-token path is master-only: an admin:query token is refused (#855)",
    async (method) => {
      const phone = await seedAgent(relay);
      const res = await onPath(method, await mintAsMobile(phone, "admin:query"));
      expect(res.status).toBe(401);
    },
  );
});
