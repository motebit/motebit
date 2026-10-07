/**
 * Differential probe for #853: percent-encoded path identity on the HTTP sync
 * doors (the reviewer's probe, r853-pct, kept whole and extended).
 *
 * The /sync/* device-auth middleware bound the token to the RAW path segment
 * (new URL(c.req.url).pathname), the handlers read the DECODED param. An
 * attacker bootstraps an identity whose id is a percent-encoding of the
 * victim's id, and pushes under the victim. Real served relay (127.0.0.1),
 * so the URL is the one a real client's request produces.
 *
 * Extended with: same-identity cells (single device, second device, master
 * token) that must read SAME on both sides; the attack from an identity an
 * earlier relay admitted (seeded, so the bootstrap refusal is not what stops
 * it); and the `/agent/:id/task?x=/result` authentication skip.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/path-identity-853.probe.ts --pkg services/relay
 *
 * Observations are statuses and booleans only — no ids — so every
 * difference is a behaviour difference.
 */
import { it, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { createTestRelay, AUTH_HEADER, signedBootstrapBody } from "./test-helpers.js";

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let base: string;
const obs: Record<string, unknown> = {};
beforeAll(async () => {
  relay = await createTestRelay();
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
}, 120_000);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe reads raw rows
const q = (sql: string, ...a: unknown[]) => relay.moteDb.db.prepare(sql).all(...a) as any[];

async function boot(id: string, device: string) {
  const kp = await generateKeypair();
  const r = await fetch(`${base}/api/v1/agents/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await signedBootstrapBody(
      { motebit_id: id, device_id: device, public_key: bytesToHex(kp.publicKey) },
      kp.privateKey,
    ),
  });
  const tok = (await mintAudienceToken({ mid: id, did: device, aud: "sync" }, kp.privateKey)).token;
  return { id, tok, kp, bootStatus: r.status };
}

/** An identity + device written directly — one an earlier relay admitted. */
async function seeded(id: string, device: string) {
  const kp = await generateKeypair();
  relay.moteDb.db
    .prepare(
      "INSERT INTO identities (motebit_id, owner_id, created_at, version_clock) VALUES (?, ?, ?, 0)",
    )
    .run(id, id, Date.now());
  seedDevice(id, device, kp);
  const tok = (await mintAudienceToken({ mid: id, did: device, aud: "sync" }, kp.privateKey)).token;
  return { id, tok };
}

function seedDevice(id: string, device: string, kp: KeyPair) {
  relay.moteDb.db
    .prepare(
      "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(device, id, crypto.randomUUID(), bytesToHex(kp.publicKey), Date.now());
}

const ev = (mid: string, m: string, clock = 1) => ({
  event_id: m,
  motebit_id: mid,
  timestamp: Date.now(),
  event_type: "memory_formed",
  payload: { content: "x", sensitivity: "none" },
  version_clock: clock,
  tombstoned: false,
});
const bearer = (tok: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${tok}`,
});
const encodedSpellingOf = (id: string) =>
  "%" + id.charCodeAt(0).toString(16).toUpperCase() + id.slice(1);

it("percent-encoded path identity", async () => {
  const V = await boot(crypto.randomUUID(), "v-laptop");
  // attacker id: first char of V's id percent-encoded
  const evilId = encodedSpellingOf(V.id);
  const X = await boot(evilId, "x-laptop");
  obs["attacker bootstrap"] = X.bootStatus;

  // V's own conversation
  const CONV = "conv-" + crypto.randomUUID();
  const own = await fetch(`${base}/sync/${V.id}/conversations`, {
    method: "POST",
    headers: bearer(V.tok),
    body: JSON.stringify({
      conversations: [
        {
          conversation_id: CONV,
          motebit_id: V.id,
          started_at: 1,
          last_active_at: 1000,
          title: null,
          summary: null,
          message_count: 1,
        },
      ],
    }),
  });
  obs["same-identity: victim posts own conversation"] = own.status;

  // Attacker pushes events naming V under the percent-encoded path
  const m = "evil-" + crypto.randomUUID();
  const r = await fetch(`${base}/sync/${evilId}/push`, {
    method: "POST",
    headers: bearer(X.tok),
    body: JSON.stringify({ events: [ev(V.id, m)] }),
  });
  obs["pct push events naming victim"] = {
    status: r.status,
    rows_under_victim: q("SELECT 1 FROM events WHERE event_id = ? AND motebit_id = ?", m, V.id)
      .length,
  };

  // Overwrite V's conversation row
  const r2 = await fetch(`${base}/sync/${evilId}/conversations`, {
    method: "POST",
    headers: bearer(X.tok),
    body: JSON.stringify({
      conversations: [
        {
          conversation_id: CONV,
          motebit_id: V.id,
          started_at: 1,
          last_active_at: 9_999_999,
          title: null,
          summary: null,
          message_count: 777,
        },
      ],
    }),
  });
  obs["pct overwrite victim conversation"] = {
    status: r2.status,
    row: q(
      "SELECT motebit_id = ? AS owner_v, last_active_at, message_count FROM sync_conversations WHERE conversation_id = ?",
      V.id,
      CONV,
    ),
  };

  // Attacker reads V's conversations
  const r2b = await fetch(`${base}/sync/${evilId}/conversations`, { headers: bearer(X.tok) });
  obs["pct read victim conversations"] = {
    status: r2b.status,
    sees: (await r2b.text()).includes(CONV),
  };

  // Victim pulls: sees the injected event?
  const pull = await fetch(`${base}/sync/${V.id}/pull?after_clock=0`, { headers: bearer(V.tok) });
  obs["victim pull sees injected event"] = {
    status: pull.status,
    sees: (await pull.text()).includes(m),
  };

  // Control: attacker's plain token against the victim's plain path is refused
  const r3 = await fetch(`${base}/sync/${V.id}/push`, {
    method: "POST",
    headers: bearer(X.tok),
    body: JSON.stringify({ events: [ev(V.id, "ctl-" + m)] }),
  });
  obs["control plain path cross"] = r3.status;

  // ── The same attack from an identity an earlier relay admitted ──
  const W = await boot(crypto.randomUUID(), "w-laptop");
  const wPush = await fetch(`${base}/sync/${W.id}/push`, {
    method: "POST",
    headers: bearer(W.tok),
    body: JSON.stringify({ events: [ev(W.id, "w-own")] }),
  });
  obs["same-identity: W pushes own event"] = wPush.status;
  const Y = await seeded(encodedSpellingOf(W.id), "y-laptop");
  const yPush = await fetch(`${base}/sync/${Y.id}/push`, {
    method: "POST",
    headers: bearer(Y.tok),
    body: JSON.stringify({ events: [ev(W.id, "y-evil")] }),
  });
  obs["held pct identity push naming W"] = {
    status: yPush.status,
    rows_under_w: q("SELECT 1 FROM events WHERE event_id = 'y-evil' AND motebit_id = ?", W.id)
      .length,
  };
  const yPull = await fetch(`${base}/sync/${Y.id}/pull?after_clock=0`, { headers: bearer(Y.tok) });
  obs["held pct identity pull of W"] = {
    status: yPull.status,
    sees: (await yPull.text()).includes("w-own"),
  };

  // ── Same-identity sync: must be SAME on both sides ──
  const vPush = await fetch(`${base}/sync/${V.id}/push`, {
    method: "POST",
    headers: bearer(V.tok),
    body: JSON.stringify({ events: [ev(V.id, "v-own", 2)] }),
  });
  obs["same-identity: victim push"] = vPush.status;
  const vPull = await fetch(`${base}/sync/${V.id}/pull?after_clock=0`, { headers: bearer(V.tok) });
  obs["same-identity: victim pull sees own"] = {
    status: vPull.status,
    sees: (await vPull.text()).includes("v-own"),
  };
  const vConv = await fetch(`${base}/sync/${V.id}/conversations`, { headers: bearer(V.tok) });
  obs["same-identity: victim reads own conversations"] = {
    status: vConv.status,
    sees: (await vConv.text()).includes(CONV),
  };
  const vClock = await fetch(`${base}/sync/${V.id}/clock`, { headers: bearer(V.tok) });
  obs["same-identity: victim clock"] = vClock.status;
  for (const kind of ["messages", "plans", "plan-steps"]) {
    const g = await fetch(
      `${base}/sync/${V.id}/${kind}${kind === "messages" ? `?conversation_id=${CONV}` : ""}`,
      { headers: bearer(V.tok) },
    );
    obs[`same-identity: victim GET ${kind}`] = g.status;
  }

  // Second device of V (the row an approved pairing writes)
  const k2 = await generateKeypair();
  seedDevice(V.id, "v-phone", k2);
  const tok2 = (await mintAudienceToken({ mid: V.id, did: "v-phone", aud: "sync" }, k2.privateKey))
    .token;
  const p2 = await fetch(`${base}/sync/${V.id}/pull?after_clock=0`, { headers: bearer(tok2) });
  obs["same-identity: second device pull sees own"] = {
    status: p2.status,
    sees: (await p2.text()).includes("v-own"),
  };
  const push2 = await fetch(`${base}/sync/${V.id}/push`, {
    method: "POST",
    headers: bearer(tok2),
    body: JSON.stringify({ events: [ev(V.id, "v-phone-1", 3)] }),
  });
  obs["same-identity: second device push"] = push2.status;

  // Master token
  const mt = await fetch(`${base}/sync/${V.id}/pull?after_clock=0`, {
    headers: { ...AUTH_HEADER },
  });
  obs["master token: pull any identity"] = {
    status: mt.status,
    sees: (await mt.text()).includes("v-own"),
  };

  // ── Sibling: task submission auth skip on a query string ──
  const t1 = await fetch(`${base}/agent/${crypto.randomUUID()}/task?x=/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ prompt: "hi" }),
  });
  obs["unauthenticated task submit with /result in query"] = t1.status;
  const t2 = await fetch(`${base}/agent/${crypto.randomUUID()}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ prompt: "hi" }),
  });
  obs["control: unauthenticated task submit"] = t2.status;
}, 300_000);
