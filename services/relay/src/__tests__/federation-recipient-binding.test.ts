/**
 * Every signed federation message names the relay it is for, and a relay acts
 * only on messages addressed to its own key (relay-federation §3.5; Inc 6 of
 * docs/design/identity-authority-writers.md §5.3).
 *
 * #1104 bound the five v2 control kinds (heartbeat, heartbeat-ack,
 * peer-remove, peer-challenge, peer-confirm) to their recipient's key. The
 * four work kinds — task/forward, task/result, settlement/forward, discover —
 * were still signed over a body that names no recipient: a body one relay
 * signed for a second verified at ANY relay that peers the signer, inside the
 * ±5 min window, and only incidental task state stopped it.
 *
 * Three relays, peered pairwise through the real handshake. The messages are
 * not built by this test: each is CAPTURED from the real sender as it leaves
 * for its recipient (A's discover fan-out and task forward to B, B's result
 * delivery to A, A's settlement forward to B), delivered to that recipient
 * (the control: accepted there), then replayed verbatim to the THIRD relay,
 * which peers the signer. The third relay must refuse it as addressed to
 * another key — `wrong_recipient_key` — and change nothing: no task row, no
 * route, no settlement row, no nonce, no forwarded discover.
 *
 * A body signed the old way (no recipient-bound message) is refused by name at
 * the very relay it was signed for: there is no downgrade path.
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
import { forwardOriginSettlement } from "../federation-callbacks.js";
import {
  AUTH_HEADER,
  createTestRelay,
  jsonAuthWithIdempotency,
  seedX402PaidTask,
} from "./test-helpers.js";
import { operatorConfirm } from "./federation-messages.js";

const URLS = {
  a: "http://relay-a.rb.test:3000",
  b: "http://relay-b.rb.test:3001",
  c: "http://relay-c.rb.test:3002",
} as const;
type Name = keyof typeof URLS;
const NAMES = Object.keys(URLS) as Name[];

const KINDS = ["discover", "task/forward", "task/result", "settlement/forward"] as const;
type Kind = (typeof KINDS)[number];

const rand = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

let relays: Record<Name, SyncRelay>;
let ids: Record<Name, RelayIdentity>;

/** One federation POST as it left its sender: where it went, its exact bytes, the answer. */
interface Captured {
  to: Name;
  kind: Kind;
  body: string;
  status: number;
}
let captured: Captured[];
/** Every relay-to-relay fetch, in order (a forwarded discover shows up here). */
let fetches: string[];

function kindOf(path: string): Kind | null {
  for (const k of KINDS) if (path === `/federation/v1/${k}`) return k;
  return null;
}

function routeFetch(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const n of NAMES) {
      if (url.startsWith(URLS[n])) {
        const path = url.slice(URLS[n].length);
        fetches.push(`${n}${path}`);
        const res = await relays[n].app.request(path, {
          method: init?.method ?? "GET",
          headers: init?.headers as Record<string, string>,
          body: init?.body as string,
        });
        const kind = kindOf(path);
        if (kind !== null) {
          captured.push({ to: n, kind, body: init?.body as string, status: res.status });
        }
        return res;
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
}

let ipSeq = 0;
/** A POST from a fresh source address, so the per-IP tier never masks the per-peer one. */
async function post(n: Name, path: string, body: string): Promise<Response> {
  ipSeq++;
  return relays[n].app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `203.0.${ipSeq >> 8}.${ipSeq & 255}`,
    },
    body,
  });
}

/** The real 1.5 handshake: cross-propose, operator-minted confirms, confirm both ways. */
async function peer(x: Name, y: Name): Promise<void> {
  const propose = async (at: Name, of: Name): Promise<string> =>
    (
      (await (
        await post(
          at,
          "/federation/v1/peer/propose",
          JSON.stringify({
            relay_id: ids[of].relayMotebitId,
            public_key: ids[of].publicKeyHex,
            endpoint_url: URLS[of],
            nonce: rand(),
          }),
        )
      ).json()) as { nonce: string }
    ).nonce;
  const nonceAtY = await propose(y, x);
  const nonceAtX = await propose(x, y);
  const confirm = async (at: Name, of: Name, nonce: string): Promise<number> =>
    (
      await post(
        at,
        "/federation/v1/peer/confirm",
        JSON.stringify({
          relay_id: ids[of].relayMotebitId,
          ...(await operatorConfirm(relays[of], nonce, AUTH_HEADER, {
            id: ids[at].relayMotebitId,
            publicKey: ids[at].publicKeyHex,
          })),
        }),
      )
    ).status;
  expect([await confirm(y, x, nonceAtY), await confirm(x, y, nonceAtX)]).toEqual([200, 200]);
}

/** Everything a federation message could move at relay `n`, byte for byte. */
function stateOf(n: Name): Record<string, unknown[]> {
  const db = relays[n].moteDb.db;
  const out: Record<string, unknown[]> = {};
  for (const t of [
    "relay_task_queue",
    "relay_task_routes",
    "relay_task_answers",
    "relay_federation_settlements",
    "relay_settlements",
    "relay_settlement_retries",
    "relay_federation_nonces",
    "relay_peers",
  ]) {
    out[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  return out;
}

interface Agent {
  motebitId: string;
  publicKeyHex: string;
  privateKey: Uint8Array;
}

/** Register an agent (identity, device, registry, listing) on relay `n`. */
async function registerAgent(n: Name, name: string, capabilities: string[]): Promise<Agent> {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const r = relays[n];
  const { motebit_id: motebitId } = (await (
    await r.app.request("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: name }),
    })
  ).json()) as { motebit_id: string };
  const agent = { motebitId, publicKeyHex, privateKey: kp.privateKey };
  await registerExisting(n, agent, name, capabilities);
  return agent;
}

/** Register an EXISTING agent (same id, same key) on relay `n` as well. */
async function registerExisting(
  n: Name,
  agent: Agent,
  name: string,
  capabilities: string[],
): Promise<void> {
  const r = relays[n];
  const json = { "Content-Type": "application/json", ...AUTH_HEADER };
  await r.app.request("/device/register", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      motebit_id: agent.motebitId,
      device_name: `${name}-device`,
      public_key: agent.publicKeyHex,
    }),
  });
  const reg = await r.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      motebit_id: agent.motebitId,
      endpoint_url: "http://localhost:0/mcp",
      capabilities,
      public_key: agent.publicKeyHex,
    }),
  });
  expect(reg.status).toBeLessThan(300);
  await r.app.request(`/api/v1/agents/${agent.motebitId}/listing`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ capabilities, pricing: [], description: `${name} service agent` }),
  });
}

/** The one capture of `kind` from `from`'s real sender to `to`. */
function captureOf(kind: Kind, to: Name): Captured {
  const hits = captured.filter((c) => c.kind === kind && c.to === to);
  expect(hits.length, `${kind} to ${to} captured`).toBeGreaterThan(0);
  return hits[0]!;
}

/**
 * Drive every kind through its REAL sender: A's task submission discovers Bob
 * on B and forwards the task to B; Bob answers on B and B delivers the result
 * to A; A forwards a funded task's settlement to B. Returns, per kind, the
 * capture and its (signer, recipient).
 */
async function driveRealSenders(): Promise<
  Record<Kind, { cap: Captured; signer: Name; recipient: Name }>
> {
  const cap = `recipient-binding-${rand().slice(0, 8)}`;
  const bob = await registerAgent("b", "bob", [cap]);
  const bobWs = { readyState: 1, send: vi.fn(), close: vi.fn() };
  relays.b.connections.set(bob.motebitId, [{ ws: bobWs as never, deviceId: "bob-device" }]);
  const alice = await registerAgent("a", "alice", ["web-search"]);

  const taskRes = await relays.a.app.request(`/agent/${alice.motebitId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({ prompt: "recipient binding", required_capabilities: [cap] }),
  });
  expect(taskRes.status, await taskRes.clone().text()).toBe(201);
  const taskId = ((await taskRes.json()) as { task_id: string }).task_id;

  const request = bobWs.send.mock.calls
    .map(
      (c: unknown[]) => JSON.parse(c[0] as string) as { type: string; task?: { task_id: string } },
    )
    .find((m) => m.type === "task_request");
  expect(request, "the forward reached Bob on B").toBeDefined();
  const bTaskId = request!.task!.task_id;
  const receipt = await signExecutionReceipt(
    {
      task_id: bTaskId,
      relay_task_id: bTaskId,
      motebit_id: bob.motebitId as unknown as MotebitId,
      device_id: "bob-device" as unknown as DeviceId,
      submitted_at: Date.now(),
      completed_at: Date.now(),
      status: "completed" as const,
      result: "done",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "ph",
      result_hash: "rh",
    },
    bob.privateKey,
  );
  const answer = await relays.b.app.request(`/agent/${bob.motebitId}/task/${bTaskId}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(receipt),
  });
  expect(answer.status, await answer.clone().text()).toBeLessThan(300);
  await vi.waitFor(() => expect(captured.some((c) => c.kind === "task/result")).toBe(true), {
    timeout: 3000,
  });
  expect(taskId).toBe(bTaskId);

  // A settlement forward from A's escrow chokepoint, for a funded task.
  const t = seedX402PaidTask(relays.a, {
    workerId: "wrk-rb",
    delegatorId: "del-rb",
    prompt: "p",
    unitCostUsd: 1.0,
  });
  const db = relays.a.moteDb.db;
  db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?").run(t);
  db.prepare(
    `INSERT OR IGNORE INTO relay_task_answers
       (task_id, executor_id, status, receipt_json, settling, settled, answer_version, answered_at)
     VALUES (?, 'wrk-rb', 'completed', '{}', 'sig-rb', 0, 1, ?)`,
  ).run(t, Date.now());
  const held = (
    db.prepare("SELECT amount_locked FROM relay_allocations WHERE task_id = ?").get(t) as {
      amount_locked: number;
    }
  ).amount_locked;
  const sent = await forwardOriginSettlement(db, ids.a, {
    taskId: t,
    receiptSignature: "sig-rb",
    peerRelayId: ids.b.relayMotebitId,
    grossAmount: held,
    platformFeeRate: 0.05,
    receiptHash: "rh",
    x402TxHash: null,
    x402Network: null,
  });
  expect(sent).toBe("delivered");

  // Bob lists on C as well (same id, same key — an agent may list on two
  // relays), registered only now so A's routing above could not pick C. So C
  // holds every local fact a replayed forward could need.
  await registerExisting("c", bob, "bob", [cap]);

  return {
    discover: { cap: captureOf("discover", "b"), signer: "a", recipient: "b" },
    "task/forward": { cap: captureOf("task/forward", "b"), signer: "a", recipient: "b" },
    "task/result": { cap: captureOf("task/result", "a"), signer: "b", recipient: "a" },
    "settlement/forward": {
      cap: captureOf("settlement/forward", "b"),
      signer: "a",
      recipient: "b",
    },
  };
}

beforeEach(async () => {
  captured = [];
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
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const r of Object.values(relays)) await r.close();
});

describe("a signed federation message is valid only at the relay it names", () => {
  it("each kind, captured from its real sender: accepted at its recipient, refused at a third relay that peers the signer", async () => {
    const sent = await driveRealSenders();
    const verdicts: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const kind of KINDS) {
      const { cap, signer, recipient } = sent[kind];
      const third = NAMES.find((n) => n !== signer && n !== recipient)!;
      const before = stateOf(third);
      const fetchesBefore = fetches.length;
      const res = await post(third, `/federation/v1/${kind}`, cap.body);
      const text = await res.text();
      verdicts[kind] = {
        // Control: the recipient accepted exactly these bytes.
        acceptedAtRecipient: cap.status < 300,
        status: res.status,
        refusedAsAnotherKey: /wrong_recipient_key/.test(text),
        // Nothing moved at the third relay, and nothing left it (no forwarded discover).
        stateUnchanged: canonicalJson(stateOf(third)) === canonicalJson(before),
        forwarded: fetches.slice(fetchesBefore),
        ...(/wrong_recipient_key/.test(text) ? {} : { body: text.slice(0, 160) }),
      };
      expected[kind] = {
        acceptedAtRecipient: true,
        status: 400,
        refusedAsAnotherKey: true,
        stateUnchanged: true,
        forwarded: [],
      };
    }
    expect(verdicts).toEqual(expected);
  });
});

describe("a signed federation message is single-use at its recipient", () => {
  it("each kind, replayed verbatim to the relay it was for: 409, and nothing changes there", async () => {
    const sent = await driveRealSenders();
    const verdicts: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const kind of KINDS) {
      const { cap, recipient } = sent[kind];
      const before = stateOf(recipient);
      const fetchesBefore = fetches.length;
      const res = await post(recipient, `/federation/v1/${kind}`, cap.body);
      const text = await res.text();
      verdicts[kind] = {
        status: res.status,
        replayed: /replayed nonce/.test(text),
        stateUnchanged: canonicalJson(stateOf(recipient)) === canonicalJson(before),
        forwarded: fetches.slice(fetchesBefore),
      };
      expected[kind] = { status: 409, replayed: true, stateUnchanged: true, forwarded: [] };
    }
    expect(verdicts).toEqual(expected);
  });
});

describe("a body signed without a recipient-bound message is refused by name (no downgrade)", () => {
  /** The pre-Inc-6 body for `kind`: fields + timestamp, signed over its canonical JSON. */
  function legacyBody(kind: Kind): Record<string, unknown> {
    const a = ids.a.relayMotebitId;
    switch (kind) {
      case "discover":
        return {
          query: { capability: "x", limit: 20 },
          hop_count: 0,
          max_hops: 1,
          visited: [a],
          query_id: crypto.randomUUID(),
          origin_relay: a,
          sender_relay: a,
          timestamp: Date.now(),
        };
      case "task/forward":
        return {
          task_id: crypto.randomUUID(),
          origin_relay: a,
          target_agent: "nobody",
          task_payload: { prompt: "p" },
          timestamp: Date.now(),
        };
      case "task/result":
        return {
          task_id: crypto.randomUUID(),
          origin_relay: a,
          receipt: {},
          timestamp: Date.now(),
        };
      case "settlement/forward":
        return {
          task_id: crypto.randomUUID(),
          settlement_id: crypto.randomUUID(),
          origin_relay: a,
          gross_amount: 1,
          receipt_hash: "rh",
          timestamp: Date.now(),
        };
    }
  }

  for (const kind of KINDS) {
    it(`${kind}: a legacy-signed body is refused at its own recipient and changes nothing`, async () => {
      const body = legacyBody(kind);
      const sig = await sign(new TextEncoder().encode(canonicalJson(body)), ids.a.privateKey);
      const before = stateOf("b");
      const fetchesBefore = fetches.length;
      const res = await post(
        "b",
        `/federation/v1/${kind}`,
        JSON.stringify({ ...body, signature: bytesToHex(sig) }),
      );
      const text = await res.text();
      expect(res.status, text).toBe(400);
      expect(text).toMatch(/v1 is refused/);
      expect(stateOf("b")).toEqual(before);
      expect(fetches.slice(fetchesBefore)).toEqual([]);
    });
  }
});
