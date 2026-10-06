/**
 * Route → audience conformance (#827) — `RELAY_ROUTE_AUDIENCES` in
 * `@motebit/protocol` says what the relay verifies, and this proves it.
 *
 * Clients resolve the audience they mint from that table
 * (`relayRouteAudience`), and `check-audience-route-parity` checks every
 * static client call site against it. Both are only as good as the table, so
 * for EVERY entry this mints a device token exactly as a client does
 * (`mintAudienceToken({ mid, did, aud }, privateKey)`) against the in-process
 * relay and asserts:
 *
 *   1. the entry's audience gets past auth (not 401, not an auth 403), and the
 *      route exists (not the router's bare 404);
 *   2. a token for a different audience is refused (401 or an auth 403) —
 *      the route really binds the audience, and the table did not name one
 *      the route merely tolerates;
 *   3. no token at all is refused — the route is not open.
 *
 * A relay middleware edit that changes a route's audience, a route that is
 * renamed or removed, or a table entry that names the wrong audience turns
 * this red. Each case seeds fresh agents on a fresh relay, because some
 * routes (revoke, revoke-tokens, deregister) end the identity they act on.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import {
  RELAY_PUBLIC_ROUTES,
  RELAY_ROUTE_AUDIENCES,
  type RelayRouteAudience,
  type TokenAudience,
} from "@motebit/protocol";
import { createTestRelay, createAgent } from "./test-helpers.js";

// Minting a proxy token requires the debit secret (subscriptions.ts): a token
// whose debits could never land is never issued.
const PREV_PROXY_SECRET = process.env.RELAY_PROXY_SECRET;
beforeAll(() => {
  process.env.RELAY_PROXY_SECRET ??= "test-relay-proxy-secret";
});
afterAll(() => {
  if (PREV_PROXY_SECRET === undefined) delete process.env.RELAY_PROXY_SECRET;
  else process.env.RELAY_PROXY_SECRET = PREV_PROXY_SECRET;
});

interface Agent {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}

async function seedAgent(relay: SyncRelay): Promise<Agent> {
  const kp = await generateKeypair();
  const { motebitId, deviceId } = await createAgent(relay, bytesToHex(kp.publicKey));
  return { motebitId, deviceId, privateKey: kp.privateKey };
}

/** The call every client's mint reduces to (web/mobile/desktop/CLI/runtime). */
async function mint(a: Agent, aud: TokenAudience): Promise<string> {
  return (await mintAudienceToken({ mid: a.motebitId, did: a.deviceId, aud }, a.privateKey)).token;
}

function concretePath(pattern: string, a: Agent): string {
  return pattern
    .split("/")
    .map((seg) => {
      if (seg === ":motebitId") return a.motebitId;
      if (seg.startsWith(":")) return `probe-${seg.slice(1)}`;
      return seg;
    })
    .join("/");
}

interface Outcome {
  status: number;
  code: string | null;
  text: string;
}

async function call(
  relay: SyncRelay,
  entry: RelayRouteAudience,
  a: Agent,
  token: string | null,
): Promise<Outcome> {
  const res = await relay.app.request(concretePath(entry.path, a), {
    method: entry.method,
    headers: {
      "Content-Type": "application/json",
      ...(token != null ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(entry.method === "GET" ? {} : { body: "{}" }),
  });
  const text = await res.text();
  let code: string | null = null;
  try {
    code = ((JSON.parse(text) as { code?: string }).code ?? null) as string | null;
  } catch {
    code = null;
  }
  return { status: res.status, code, text } satisfies Outcome;
}

/** A refusal by an auth layer: 401, or a 403 whose code is a device-auth refusal. */
function refusedByAuth(o: Outcome): boolean {
  if (o.status === 401) return true;
  return (
    o.status === 403 &&
    o.code != null &&
    /^AUTHZ_(DEVICE_NOT_AUTHORIZED|INVALID_CREDENTIALS)$/.test(o.code)
  );
}

/** Hono's own not-found — the route is not registered at all. */
function routeMissing(o: Outcome): boolean {
  return o.status === 404 && o.text.trim() === "404 Not Found";
}

// The WebSocket upgrade cannot be driven through `app.request`; its audience
// is pinned by the websocket tests (the `/ws/sync/:motebitId` handler verifies
// under `sync`). Every other entry is exercised here.
const HTTP_ENTRIES = RELAY_ROUTE_AUDIENCES.filter((e) => e.path !== "/ws/sync/:motebitId");

function otherAudience(aud: TokenAudience): TokenAudience {
  return aud === "sync" ? "device:auth" : "sync";
}

describe("RELAY_ROUTE_AUDIENCES conforms to the relay (#827)", () => {
  let relay: SyncRelay;

  // A fresh relay per case: the per-route rate limiters would otherwise
  // answer 429 before auth on the later cases of a shared relay.
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it.each(HTTP_ENTRIES.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s accepts exactly its table audience",
    async (_label, entry) => {
      const agent = await seedAgent(relay);
      const good = await call(relay, entry, agent, await mint(agent, entry.audience));
      expect(routeMissing(good), `route not registered: ${good.status} ${good.text}`).toBe(false);
      expect(refusedByAuth(good), `table audience refused: ${good.status} ${good.text}`).toBe(
        false,
      );

      const other = await seedAgent(relay);
      const wrong = await call(
        relay,
        entry,
        other,
        await mint(other, otherAudience(entry.audience)),
      );
      expect(refusedByAuth(wrong), `wrong audience accepted: ${wrong.status} ${wrong.text}`).toBe(
        true,
      );

      const none = await call(relay, entry, other, null);
      expect(refusedByAuth(none), `no token accepted: ${none.status} ${none.text}`).toBe(true);
    },
  );

  it("every table entry is exercised or explicitly excluded", () => {
    expect(HTTP_ENTRIES.length + 1).toBe(RELAY_ROUTE_AUDIENCES.length);
  });

  it.each(RELAY_PUBLIC_ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))(
    "public %s exists and takes no token",
    async (_label, route) => {
      const agent = await seedAgent(relay);
      const o = await call(relay, { ...route, audience: "sync" }, agent, null);
      expect(routeMissing(o), `route not registered: ${o.status} ${o.text}`).toBe(false);
      expect(refusedByAuth(o), `public route refused a bare request: ${o.status} ${o.text}`).toBe(
        false,
      );
    },
  );
});

// HEAD is served by the GET handler (Hono), so it must be authenticated
// exactly as its GET. The table has no HEAD rows; before `relayRouteAudience`
// mapped HEAD → GET, a HEAD fell to the `admin:query` default and an
// admin:query token read `/credentials`, `/receipts`, `/p2p-eligibility`,
// `/roster` — and, on a relay with no master token (no dualAuth layer),
// `/balance`, `/settlements`, `/withdrawals` (#836 review). Both relay shapes.
describe("HEAD is authenticated as its GET (#836)", () => {
  const GET_ENTRIES = HTTP_ENTRIES.filter((e) => e.method === "GET");

  async function head(relay: SyncRelay, path: string, token: string | null): Promise<number> {
    const res = await relay.app.request(path, {
      method: "HEAD",
      headers: token != null ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.status;
  }

  for (const master of [true, false]) {
    describe(master ? "master-token relay" : "relay with no master token", () => {
      let relay: SyncRelay;
      beforeEach(async () => {
        relay = master
          ? await createTestRelay()
          : await createTestRelay({ apiToken: undefined, allowInsecureNoAuth: true });
      });
      afterEach(async () => {
        await relay.close();
      });

      it.each(GET_ENTRIES.map((e) => [`HEAD ${e.path}`, e] as const))(
        "%s is refused exactly when its GET is",
        async (_label, entry) => {
          // For each token — the table's audience, another, none — HEAD and
          // GET must agree on refusal. (On a relay with no master token some
          // routes have no auth layer at all, for GET too; parity is the
          // invariant, and the master-token relay also pins the audience.)
          const a = await seedAgent(relay);
          const path = concretePath(entry.path, a);
          const wrongAud: TokenAudience = entry.audience === "admin:query" ? "sync" : "admin:query";
          const refused = (s: number) => s === 401 || s === 403;
          for (const aud of [entry.audience, wrongAud, null] as const) {
            const token = aud == null ? null : await mint(a, aud);
            const getStatus = (
              await relay.app.request(path, {
                headers: token != null ? { Authorization: `Bearer ${token}` } : {},
              })
            ).status;
            const headStatus = await head(relay, path, token);
            expect(
              refused(headStatus),
              `${String(aud)}: HEAD ${headStatus} vs GET ${getStatus}`,
            ).toBe(refused(getStatus));
            if (master && aud === entry.audience) expect(headStatus).not.toBe(401);
            if (master && aud !== entry.audience) expect(refused(headStatus)).toBe(true);
          }
        },
      );
    });
  }

  it.each(["credentials", "receipts", "p2p-eligibility", "roster"])(
    "the #836 cells: admin:query on HEAD /%s is refused (master relay)",
    async (sub) => {
      const relay = await createTestRelay();
      try {
        const a = await seedAgent(relay);
        expect(
          await head(relay, `/api/v1/agents/${a.motebitId}/${sub}`, await mint(a, "admin:query")),
        ).toBe(401);
      } finally {
        await relay.close();
      }
    },
  );

  it.each(["balance", "settlements", "withdrawals"])(
    "the #836 cells: admin:query on HEAD /%s is refused (no-master relay)",
    async (sub) => {
      const relay = await createTestRelay({ apiToken: undefined, allowInsecureNoAuth: true });
      try {
        const a = await seedAgent(relay);
        expect(
          await head(relay, `/api/v1/agents/${a.motebitId}/${sub}`, await mint(a, "admin:query")),
        ).toBe(401);
      } finally {
        await relay.close();
      }
    },
  );
});

// The agent-route middleware used to pick the audience with `includes` /
// `endsWith` on the path alone. A four-segment path whose id equals a
// sub-route name — `GET /api/v1/agents/roster` — was authenticated with the
// sub-route's audience and then served by `GET /api/v1/agents/:motebitId`,
// which expects `admin:query` (#827, from the #828 review). Each sibling
// literal the chain matched must now get the `:motebitId` route's audience,
// and an audience applies only to the method of the route it names.
const FORMER_FAMILY_AUDIENCE: ReadonlyArray<readonly [string, TokenAudience]> = [
  ["p2p-eligibility", "market:listing"],
  ["listing", "market:listing"],
  ["credentials", "credentials"],
  ["presentation", "credentials:present"],
  ["rotate-key", "rotate-key"],
  ["proxy-token", "proxy:token"],
  ["receipts", "receipts:read"],
  ["balance", "account:balance"],
  ["settlements", "account:balance"],
  ["rotation-obligations", "account:balance"],
  ["withdrawals", "account:withdrawals"],
  ["withdraw", "account:withdraw"],
  ["checkout", "account:checkout"],
  ["roster", "device:auth"],
];

describe("agent-route audience is keyed by method and route shape (#827 / #828)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  const get = (path: string, token: string) =>
    relay.app.request(path, { headers: { Authorization: `Bearer ${token}` } });

  it.each(FORMER_FAMILY_AUDIENCE)(
    "GET /api/v1/agents/%s is the :motebitId route: its sub-route audience (%s) is refused, admin:query is not",
    async (literal, formerAudience) => {
      const agent = await seedAgent(relay);
      const asSubRoute = await get(`/api/v1/agents/${literal}`, await mint(agent, formerAudience));
      expect(asSubRoute.status).toBe(401);
      const asRegistryRead = await get(
        `/api/v1/agents/${literal}`,
        await mint(agent, "admin:query"),
      );
      expect(asRegistryRead.status).not.toBe(401);
    },
  );

  it("an audience applies only to its route's method", async () => {
    const agent = await seedAgent(relay);
    // rotate-key is a POST route; a GET with the rotate-key audience is not it.
    const wrongMethod = await get(
      `/api/v1/agents/${agent.motebitId}/rotate-key`,
      await mint(agent, "rotate-key"),
    );
    expect(wrongMethod.status).toBe(401);
    // The roster is GET and POST, both device:auth; a DELETE is neither.
    const del = await relay.app.request(`/api/v1/agents/${agent.motebitId}/roster`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await mint(agent, "device:auth")}` },
    });
    expect(del.status).toBe(401);
  });
});
