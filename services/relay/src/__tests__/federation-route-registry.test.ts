/**
 * Deny by default, proven by execution: every route the relay REGISTERS under
 * `/federation` is in `FEDERATION_ROUTE_REGISTRY` (relay-federation@1.5 §3.5),
 * and every route that acts on a signed message refuses — before any write and
 * before any outbound request — the two messages a relay must never act on:
 *
 *   (a) a correctly signed v2 message from an active peer, addressed to
 *       ANOTHER relay's key (once by that relay's id, once by THIS relay's id
 *       with the other relay's key);
 *   (b) the v1 body: the same fields, a `timestamp` and a v1 hex signature by
 *       the same peer, and no `message` (the downgrade).
 *
 * The routes come from the booted relay's Hono router (`app.routes`), not from
 * source text: a route registered by any method, through any path spelling or
 * any sub-router, is seen. An unregistered route, a registry entry the relay
 * no longer serves, and a second registration at a registered (method, path)
 * are each red. The snapshot after each refusal is every table in the
 * relay's database, row for row, and every fetch the relay made.
 *
 * A control cell sends the same body addressed to THIS relay and requires it
 * to be accepted, so a refusal above is the recipient binding speaking, not a
 * malformed body. Where the accepted body writes (`controlWrites`), the
 * control requires the write too, so a handler that acted before verifying
 * would have been seen. A fabricated `task-result` answers no task this relay
 * routed, so its control is verified (the nonce row is its write) and then
 * answered 404 by the handler. `peer-confirm` has no control: a confirm acts only on
 * a handshake this relay issued, and the handshake suites cover it
 * (`federation-confirm-binding.test.ts`).
 *
 * Static companion: `federation-signed-kinds.test.ts` (call-site shape).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  bytesToHex,
  canonicalJson,
  generateKeypair,
  sign,
  signExecutionReceipt,
} from "@motebit/encryption";
import type { DeviceId, MotebitId } from "@motebit/sdk";

import type { SyncRelay } from "../index.js";
import { initRelayIdentity, type RelayIdentity } from "../federation.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import {
  heartbeatRequest,
  operatorConfirm,
  removeRequest,
  signedConfirm,
  workRequest,
} from "./federation-messages.js";
import { UNENVELOPED_ROUTES } from "./federation-route-scan.js";

type SignedKind =
  | "heartbeat"
  | "peer-remove"
  | "peer-confirm"
  | "discover"
  | "task-forward"
  | "task-result"
  | "settlement-forward";

type RegistryEntry =
  | {
      method: string;
      path: string;
      kind: SignedKind;
      controlWrites: boolean | null;
      /** The control's status when not 2xx. */
      controlStatus?: number;
    }
  | { method: string; path: string; exempt: string };

const RATE_LIMIT = "rate-limit middleware (`middleware.ts`): counts requests, writes no row";
const READ_ONLY = "read-only GET: serves this relay's own state and writes nothing";

/**
 * Every (method, path) the relay registers under `/federation`, exactly once.
 * A route that acts on a signed message names its §3.5 kind; any other names
 * why it needs no recipient binding (`UNENVELOPED_ROUTES` for the unenveloped
 * POSTs). `controlWrites`: the correctly addressed control body writes a row
 * (`null`: no control — see the header).
 */
export const FEDERATION_ROUTE_REGISTRY: readonly RegistryEntry[] = [
  { method: "ALL", path: "/federation/v1/peer/*", exempt: RATE_LIMIT },
  { method: "ALL", path: "/federation/v1/discover", exempt: RATE_LIMIT },
  { method: "ALL", path: "/federation/v1/task/*", exempt: RATE_LIMIT },
  { method: "ALL", path: "/federation/v1/settlement/*", exempt: RATE_LIMIT },
  { method: "ALL", path: "/federation/v1/settlements", exempt: RATE_LIMIT },
  { method: "GET", path: "/federation/v1/identity", exempt: READ_ONLY },
  { method: "GET", path: "/federation/v1/peers", exempt: READ_ONLY },
  { method: "GET", path: "/federation/v1/settlements", exempt: READ_ONLY },
  { method: "GET", path: "/federation/v1/settlement/proof", exempt: READ_ONLY },
  ...Object.entries(UNENVELOPED_ROUTES).map(([path, exempt]) => ({
    method: "POST",
    path,
    exempt,
  })),
  {
    method: "POST",
    path: "/federation/v1/peer/confirm",
    kind: "peer-confirm",
    controlWrites: null,
  },
  {
    method: "POST",
    path: "/federation/v1/peer/heartbeat",
    kind: "heartbeat",
    controlWrites: true,
  },
  { method: "POST", path: "/federation/v1/peer/remove", kind: "peer-remove", controlWrites: true },
  { method: "POST", path: "/federation/v1/discover", kind: "discover", controlWrites: true },
  {
    method: "POST",
    path: "/federation/v1/task/forward",
    kind: "task-forward",
    controlWrites: true,
  },
  // A fabricated result answers no task this relay routed: the verified
  // control spends its nonce (the write) and the handler answers 404.
  {
    method: "POST",
    path: "/federation/v1/task/result",
    kind: "task-result",
    controlWrites: true,
    controlStatus: 404,
  },
  {
    method: "POST",
    path: "/federation/v1/settlement/forward",
    kind: "settlement-forward",
    controlWrites: true,
  },
];

const URLS = {
  a: "http://relay-a.rr.test:3000",
  b: "http://relay-b.rr.test:3001",
  c: "http://relay-c.rr.test:3002",
} as const;
type Name = keyof typeof URLS;
const NAMES = Object.keys(URLS) as Name[];

const rand = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

let relays: Record<Name, SyncRelay>;
let ids: Record<Name, RelayIdentity>;
/** Every fetch any relay made, in order. */
let fetches: string[];

function routeFetch(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetches.push(url);
    for (const n of NAMES) {
      if (url.startsWith(URLS[n])) {
        return relays[n].app.request(url.slice(URLS[n].length), {
          method: init?.method ?? "GET",
          headers: init?.headers as Record<string, string>,
          body: init?.body as string,
        });
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
}

let ipSeq = 0;
/** A POST from a fresh source address, so the per-IP tier never masks a verdict. */
async function post(n: Name, path: string, body: unknown): Promise<Response> {
  ipSeq++;
  return relays[n].app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `198.51.${ipSeq >> 8}.${ipSeq & 255}`,
    },
    body: JSON.stringify(body),
  });
}

/** The real 1.5 handshake between `x` and `y`. */
async function peer(x: Name, y: Name): Promise<void> {
  const propose = async (at: Name, of: Name): Promise<string> =>
    (
      (await (
        await post(at, "/federation/v1/peer/propose", {
          relay_id: ids[of].relayMotebitId,
          public_key: ids[of].publicKeyHex,
          endpoint_url: URLS[of],
          nonce: rand(),
        })
      ).json()) as { nonce: string }
    ).nonce;
  const nonceAtY = await propose(y, x);
  const nonceAtX = await propose(x, y);
  const confirm = async (at: Name, of: Name, nonce: string): Promise<number> =>
    (
      await post(at, "/federation/v1/peer/confirm", {
        relay_id: ids[of].relayMotebitId,
        ...(await operatorConfirm(relays[of], nonce, AUTH_HEADER, {
          id: ids[at].relayMotebitId,
          publicKey: ids[at].publicKeyHex,
        })),
      })
    ).status;
  expect([await confirm(y, x, nonceAtY), await confirm(x, y, nonceAtX)]).toEqual([200, 200]);
}

/** Every table of relay `n`, row for row. */
function stateOf(n: Name): string {
  const db = relays[n].moteDb.db;
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((t) => t.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = db.prepare(`SELECT * FROM "${t}"`).all();
  return canonicalJson(out);
}

/** An agent registered and listed on relay `n`, so a forwarded task has a target. */
async function registerAgent(n: Name, capability: string): Promise<string> {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const r = relays[n];
  const json = { "Content-Type": "application/json", ...AUTH_HEADER };
  const { motebit_id: motebitId } = (await (
    await r.app.request("/identity", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ owner_id: "route-registry" }),
    })
  ).json()) as { motebit_id: string };
  await r.app.request("/device/register", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      motebit_id: motebitId,
      device_name: "rr-device",
      public_key: publicKeyHex,
    }),
  });
  const reg = await r.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:0/mcp",
      capabilities: [capability],
      public_key: publicKeyHex,
    }),
  });
  expect(reg.status).toBeLessThan(300);
  return motebitId;
}

/** Whom a message is addressed to: by id and by key. */
interface Addressee {
  relayMotebitId: string;
  publicKeyHex: string;
}

/**
 * The request body for `kind` from relay A to relay B's route, signed by A as
 * a v2 message for `to` (`"v1"`: no `message`, a timestamp and a v1 hex
 * signature by A instead).
 */
async function requestFor(kind: SignedKind, to: Addressee | "v1"): Promise<unknown> {
  const a = ids.a.relayMotebitId;
  const key = ids.a.privateKey;
  const v1 = async (fields: Record<string, unknown>): Promise<unknown> => {
    const body = { ...fields, timestamp: Date.now() };
    const sig = await sign(new TextEncoder().encode(canonicalJson(body)), key);
    return { ...body, signature: bytesToHex(sig) };
  };
  switch (kind) {
    case "heartbeat":
      if (to === "v1") return v1({ relay_id: a, agent_count: 0 });
      return heartbeatRequest({
        sender: a,
        recipient: to.relayMotebitId,
        recipientPublicKey: to.publicKeyHex,
        privateKey: key,
      });
    case "peer-remove":
      if (to === "v1") return v1({ relay_id: a });
      return removeRequest({
        sender: a,
        recipient: to.relayMotebitId,
        recipientPublicKey: to.publicKeyHex,
        privateKey: key,
      });
    case "peer-confirm": {
      const nonce = rand();
      if (to === "v1") return v1({ relay_id: a, nonce, challenge_response: rand() });
      return {
        relay_id: a,
        ...(await signedConfirm({
          sender: a,
          recipient: to.relayMotebitId,
          recipientPublicKey: to.publicKeyHex,
          nonce,
          endpointUrl: URLS.a,
          privateKey: key,
        })),
      };
    }
    case "discover":
    case "task-forward":
    case "task-result":
    case "settlement-forward": {
      const route = `/federation/v1/${ROUTE_OF[kind]}` as const;
      const fields = workFields(kind);
      if (to === "v1") return v1(fields);
      return workRequest({ route, body: fields, privateKey: key, recipient: to });
    }
  }
}

const ROUTE_OF = {
  discover: "discover",
  "task-forward": "task/forward",
  "task-result": "task/result",
  "settlement-forward": "settlement/forward",
} as const;

const CAPABILITY = "route-registry-cap";
/** Relay B's listed agent, the target of a forwarded task. */
let bAgent: string;
/** A well-formed signed receipt for a task-result body. */
let resultReceipt: unknown;

/** A work request's own fields from A, each one B would act on if it were accepted. */
function workFields(kind: keyof typeof ROUTE_OF): Record<string, unknown> {
  const a = ids.a.relayMotebitId;
  switch (kind) {
    case "discover":
      // hop_count < max_hops and C unvisited: an accepted discover is
      // re-forwarded to C, so an acting handler shows up as a fetch.
      return {
        query: { capability: CAPABILITY, limit: 10 },
        hop_count: 0,
        max_hops: 2,
        visited: [a],
        query_id: crypto.randomUUID(),
        origin_relay: a,
        sender_relay: a,
      };
    case "task-forward":
      return {
        task_id: crypto.randomUUID(),
        origin_relay: a,
        target_agent: bAgent,
        task_payload: { prompt: "route registry", required_capabilities: [CAPABILITY] },
      };
    case "task-result":
      return {
        task_id: crypto.randomUUID(),
        origin_relay: a,
        receipt: resultReceipt,
      };
    case "settlement-forward":
      return {
        task_id: crypto.randomUUID(),
        settlement_id: crypto.randomUUID(),
        origin_relay: a,
        gross_amount: 1_000_000,
        receipt_hash: "rh",
      };
  }
}

beforeEach(async () => {
  fetches = [];
  relays = {} as Record<Name, SyncRelay>;
  ids = {} as Record<Name, RelayIdentity>;
  for (const n of NAMES) {
    relays[n] = await createTestRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: URLS[n], displayName: `Relay ${n}` },
    });
    ids[n] = await initRelayIdentity(relays[n].moteDb.db);
  }
  routeFetch();
  await peer("a", "b");
  await peer("a", "c");
  await peer("b", "c");
  bAgent = await registerAgent("b", CAPABILITY);
  const worker = await generateKeypair();
  resultReceipt = await signExecutionReceipt(
    {
      task_id: "route-registry-task",
      motebit_id: "route-registry-worker" as unknown as MotebitId,
      device_id: "rr-device" as unknown as DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "done",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "ph",
      result_hash: "rh",
    },
    worker.privateKey,
  );
  fetches = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const r of Object.values(relays)) await r.close();
});

/** The routes relay B registers under `/federation`, as `METHOD path`, with multiplicity. */
function registeredFederationRoutes(): string[] {
  return relays.b.app.routes
    .filter((r) => r.path === "/federation" || r.path.startsWith("/federation/"))
    .map((r) => `${r.method} ${r.path}`)
    .sort();
}

describe("every route the relay registers under /federation is in the registry", () => {
  it("registered routes == registry, as a multiset (unregistered, stale, duplicate: red)", () => {
    const registered = registeredFederationRoutes();
    const declared = FEDERATION_ROUTE_REGISTRY.map((e) => `${e.method} ${e.path}`).sort();
    expect(new Set(declared).size, "registry lists each (method, path) once").toBe(declared.length);
    expect(registered).toEqual(declared);
    // eslint-disable-next-line no-console -- aperture disclosure
    console.log(
      `[federation-route-registry] ${registered.length} registered /federation routes; ${
        FEDERATION_ROUTE_REGISTRY.filter((e) => "kind" in e).length
      } act on a signed message, each driven below`,
    );
  });
});

const SIGNED = FEDERATION_ROUTE_REGISTRY.filter(
  (e): e is Extract<RegistryEntry, { kind: SignedKind }> => "kind" in e,
);

describe("every signed federation route refuses a message not addressed to this relay's key, and the v1 body", () => {
  for (const entry of SIGNED) {
    it(`${entry.method} ${entry.path} (${entry.kind})`, async () => {
      const cells: Record<string, () => Promise<unknown>> = {
        wrongRecipient: () => requestFor(entry.kind, ids.c),
        wrongRecipientKeyOwnId: () =>
          requestFor(entry.kind, {
            relayMotebitId: ids.b.relayMotebitId,
            publicKeyHex: ids.c.publicKeyHex,
          }),
        v1NoMessage: () => requestFor(entry.kind, "v1"),
      };
      const verdicts: Record<string, unknown> = {};
      const expected: Record<string, unknown> = {};
      for (const [cell, build] of Object.entries(cells)) {
        const body = await build();
        const before = stateOf("b");
        const fetchesBefore = fetches.length;
        const res = await post("b", entry.path, body);
        const text = await res.text();
        verdicts[cell] = {
          status: res.status,
          stateUnchanged: stateOf("b") === before,
          outbound: fetches.slice(fetchesBefore),
          ...(res.status === 400 ? {} : { body: text.slice(0, 200) }),
        };
        expected[cell] = { status: 400, stateUnchanged: true, outbound: [] };
      }
      expect(verdicts).toEqual(expected);

      // Control: the same body, addressed to THIS relay, is acted on.
      if (entry.controlWrites !== null) {
        const before = stateOf("b");
        const res = await post("b", entry.path, await requestFor(entry.kind, ids.b));
        const text = await res.text();
        if (entry.controlStatus !== undefined) expect(res.status, text).toBe(entry.controlStatus);
        else expect(res.status, text).toBeLessThan(300);
        if (entry.controlWrites) expect(stateOf("b")).not.toBe(before);
      }
    });
  }
});
