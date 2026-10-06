/**
 * The relay's signed sync hold receipt (Inc 1 — the relay signs;
 * `sync-hold-receipt.ts`, spec/sync-hold-receipt-v1.md).
 *
 * The hole: a device compacts what a relay "holds", and "holds" was read off
 * the transport (a 2xx, an `ack`, a served page), so any server answering the
 * relay URL could make a device delete events the real relay never stored.
 * These tests pin what the relay now signs, through the real routes:
 *
 *   (a) the receipt lists what is STORED, never the frame — a skipped receipt
 *       duplicate, an id held under another identity, a refused (unbound)
 *       frame are absent; an id genuinely held already is present;
 *   (b) it verifies under the relay's PUBLISHED key, and fails on a single
 *       field tamper, a wrong key, or another artifact re-labelled;
 *   (c) the client nonce is echoed exactly (absent/unusable ⇒ no receipt);
 *   (d) a pull page's receipt covers its seq range — altering from/to fails;
 *   (e) a redacted event is marked redacted with the digest of the stored
 *       (redacted) bytes; older stored ciphertext is described as stored;
 *   (f) every field an existing client reads is unchanged — only
 *       `hold_receipt` is added (and the clock pull is untouched).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import type { EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { SyncHoldReceipt } from "@motebit/protocol";
import { computeSyncEventDigest, verifySyncHoldReceipt } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, API_TOKEN, createTestRelay } from "./test-helpers.js";

const NONCE = "hR7c2Vq0tLmZ9xWb4nYp1sKdE6";

/** The full expectation triple a verifying client passes (all three required). */
function pinned(mid: string) {
  return { expectedPublicKey: relayKey, expectedNonce: NONCE, expectedMotebitId: mid };
}

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let port: number;
let relayKey: string;

beforeAll(async () => {
  relay = await createTestRelay({ enableDeviceAuth: false });
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  port = (server.address() as AddressInfo).port;
  const ident = (await (await relay.app.request("/federation/v1/identity")).json()) as {
    public_key: string;
  };
  relayKey = ident.public_key;
}, 60_000);

afterAll(async () => {
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
}, 60_000);

let clock = 1;
function entry(mid: string, overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: mid,
    event_type: EventType.StateUpdated,
    payload: { n: clock },
    version_clock: clock++,
    timestamp: 1_760_000_000_000 + clock,
    tombstoned: false,
    ...overrides,
  } as EventLogEntry;
}

async function push(
  mid: string,
  events: EventLogEntry[],
  /** Defaults to NONCE (a receipt is issued only to a nonce-bearing request); `null` sends none. */
  nonce: unknown = NONCE,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await relay.app.request(`/sync/${mid}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(nonce === null ? { events } : { events, nonce }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function pullSeq(
  mid: string,
  query: string,
  /** Adds `&nonce=NONCE` to a seq pull unless the query names its own (or this is false). */
  withNonce = true,
): Promise<Record<string, unknown>> {
  const q =
    withNonce && query.includes("after_seq") && !query.includes("nonce=")
      ? `${query}&nonce=${NONCE}`
      : query;
  const res = await relay.app.request(`/sync/${mid}/pull?${q}`, { headers: AUTH_HEADER });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function receiptOf(body: Record<string, unknown>): SyncHoldReceipt {
  expect(body.hold_receipt, "response carries a hold_receipt").toBeDefined();
  return body.hold_receipt as SyncHoldReceipt;
}

function ids(r: SyncHoldReceipt): string[] {
  return r.events.map((e) => e.event_id);
}

async function wsPush(
  mid: string,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync/${mid}?token=${API_TOKEN}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const ack = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (d: Buffer) => {
        const m = JSON.parse(d.toString("utf8")) as Record<string, unknown>;
        if (m.type === "ack") resolve(m);
      });
    });
    // A receipt is issued only to a nonce-bearing frame; `nonce: undefined` sends none.
    ws.send(
      JSON.stringify({ type: "push", ...("nonce" in frame ? {} : { nonce: NONCE }), ...frame }),
    );
    return await ack;
  } finally {
    ws.terminate();
  }
}

describe("(a) the receipt names what the relay stores, never the frame", () => {
  it("HTTP push: a skipped receipt duplicate is absent; a re-pushed held id is present", async () => {
    const mid = crypto.randomUUID();
    const receipt = { signature: `sig-${crypto.randomUUID()}`, task_id: "t" };
    const first = entry(mid, { payload: { receipt } });
    await push(mid, [first], NONCE);

    // Same receipt signature under a NEW event id: the relay skips it and
    // still acknowledges. A fresh event rides in the same frame.
    const dup = entry(mid, { payload: { receipt } });
    const fresh = entry(mid);
    const res = await push(mid, [dup, fresh], NONCE);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.duplicates).toBe(1);
    expect(ids(receiptOf(res.body))).toEqual([fresh.event_id]);

    // Re-pushing the original (same id) is a skipped duplicate too — but the
    // relay genuinely holds that id, so it is listed.
    const again = await push(mid, [first], NONCE);
    expect(again.body.duplicate).toBe(true);
    expect(ids(receiptOf(again.body))).toEqual([first.event_id]);
  });

  it("an id already stored under ANOTHER identity is not listed for this one", async () => {
    const other = crypto.randomUUID();
    const mid = crypto.randomUUID();
    const squatted = entry(other);
    await push(other, [squatted]);
    // Same event_id pushed for `mid`: INSERT OR IGNORE keeps the other row.
    const mine = entry(mid, { event_id: squatted.event_id });
    const res = await push(mid, [mine], NONCE);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1); // the old ack still counts it
    expect(ids(receiptOf(res.body))).toEqual([]);
  });

  it("an entry the store silently drops (no event_type) is acked but never listed", async () => {
    const mid = crypto.randomUUID();
    const typeless = { ...entry(mid) } as Partial<EventLogEntry>;
    delete typeless.event_type;
    const kept = entry(mid);
    const res = await push(mid, [typeless as EventLogEntry, kept], NONCE);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2); // the transport ack counts both
    expect(ids(receiptOf(res.body))).toEqual([kept.event_id]); // the receipt does not
  });

  it("a frame carrying an unbound entry is refused whole — no receipt, nothing held", async () => {
    const mid = crypto.randomUUID();
    const ok = entry(mid);
    const foreign = entry(crypto.randomUUID());
    const res = await push(mid, [ok, foreign], NONCE);
    expect(res.status).toBe(403);
    expect(res.body.hold_receipt).toBeUndefined();
    const page = await pullSeq(mid, "after_seq=0");
    expect(ids(receiptOf(page))).toEqual([]);
  });

  it("WebSocket ack: a skipped receipt duplicate is absent", async () => {
    const mid = crypto.randomUUID();
    const receipt = { signature: `sig-${crypto.randomUUID()}` };
    const first = entry(mid, { payload: { receipt } });
    await push(mid, [first]);
    const dup = entry(mid, { payload: { receipt } });
    const fresh = entry(mid);
    const ack = await wsPush(mid, { push_id: "p1", nonce: NONCE, events: [dup, fresh] });
    expect(ids(receiptOf(ack))).toEqual([fresh.event_id]);
  });
});

describe("(b) the receipt verifies under the relay's published key, and only it", () => {
  it("verifies pinned + nonce-checked; fails on tamper, wrong key, re-labelled artifact", async () => {
    const mid = crypto.randomUUID();
    const res = await push(mid, [entry(mid), entry(mid)], NONCE);
    const r = receiptOf(res.body);
    expect(r.relay_public_key).toBe(relayKey.toLowerCase());
    expect(r.motebit_id).toBe(mid);
    expect(r.page).toBeUndefined();
    expect(await verifySyncHoldReceipt(r, pinned(mid))).toEqual({ valid: true });

    const tampers: Array<Partial<SyncHoldReceipt>> = [
      { motebit_id: crypto.randomUUID() },
      { relay_motebit_id: "impostor" },
      { issued_at: r.issued_at + 1 },
      { nonce: NONCE.replace("h", "H") },
      { events: r.events.slice(1) },
      { events: [{ ...r.events[0]!, digest: "0".repeat(64) }, ...r.events.slice(1)] },
      { events: [{ ...r.events[0]!, redacted: true }, ...r.events.slice(1)] },
    ];
    for (const t of tampers) {
      expect(
        (await verifySyncHoldReceipt({ ...r, ...t }, pinned(mid))).valid,
        JSON.stringify(t),
      ).toBe(false);
    }
    // A wrong pinned key (an impostor's own, self-consistent receipt).
    const impostorKey = "ab".repeat(32);
    expect(
      await verifySyncHoldReceipt(r, { ...pinned(mid), expectedPublicKey: impostorKey }),
    ).toEqual({
      valid: false,
      reason: "public_key_mismatch",
    });
    // Another relay-signed artifact (the transparency declaration) re-labelled.
    const decl = (await (
      await relay.app.request("/.well-known/motebit-transparency.json")
    ).json()) as Record<string, unknown>;
    const relabelled = {
      ...decl,
      spec: "motebit/sync-hold-receipt@1.0",
      suite: "motebit-jcs-ed25519-b64-v1",
      relay_motebit_id: r.relay_motebit_id,
      relay_public_key: r.relay_public_key,
      motebit_id: mid,
      issued_at: r.issued_at,
      events: [],
    } as unknown as SyncHoldReceipt;
    expect(
      (await verifySyncHoldReceipt(relabelled, { ...pinned(mid), expectedPublicKey: relayKey }))
        .valid,
    ).toBe(false);
    // A push receipt replayed as a page (page grafted on) fails.
    expect(
      (
        await verifySyncHoldReceipt(
          { ...r, events: [], page: { after_seq: 0, next_seq: 0, has_more: false, latest_seq: 0 } },
          { ...pinned(mid), expectedPublicKey: relayKey },
        )
      ).valid,
    ).toBe(false);
  });
});

describe("(c) the client nonce is echoed exactly; no nonce ⇒ no receipt", () => {
  it("HTTP push, WebSocket ack and seq pull echo it; absent or unusable ⇒ no hold_receipt at all", async () => {
    const mid = crypto.randomUUID();
    expect(receiptOf((await push(mid, [entry(mid)], NONCE)).body).nonce).toBe(NONCE);
    const ack = await wsPush(mid, { nonce: NONCE, events: [entry(mid)] });
    expect(receiptOf(ack).nonce).toBe(NONCE);
    expect(receiptOf(await pullSeq(mid, `after_seq=0&nonce=${NONCE}`)).nonce).toBe(NONCE);

    // A receipt without the client's nonce answers no request (spec §5), so
    // none is issued: the response is exactly main's.
    const noNonce = await push(mid, [entry(mid)], null);
    expect(noNonce.body).toEqual({ motebit_id: mid, accepted: 1, duplicates: 0 });
    // Too short to be ≥128 bits, wrong type, illegal characters: no receipt.
    for (const bad of ["short", 12345, "x".repeat(21), "has spaces in it, 22+ chars"]) {
      expect((await push(mid, [entry(mid)], bad)).body.hold_receipt, String(bad)).toBeUndefined();
    }
    const wsAck = await wsPush(mid, { push_id: "x", nonce: undefined, events: [entry(mid)] });
    expect(wsAck.hold_receipt).toBeUndefined();
    expect(wsAck.push_id).toBe("x");
    expect((await pullSeq(mid, "after_seq=0", false)).hold_receipt).toBeUndefined();
    expect((await pullSeq(mid, "after_seq=0&nonce=short")).hold_receipt).toBeUndefined();
  });
});

describe("(d) a pull page's receipt covers its seq range", () => {
  it("lists the page's ids, seqs and digests; altering from/to fails", async () => {
    const mid = crypto.randomUUID();
    const pushed = [entry(mid), entry(mid), entry(mid)];
    await push(mid, pushed);

    const page = await pullSeq(mid, `after_seq=1&limit=1&nonce=${NONCE}`);
    const r = receiptOf(page);
    const served = page.events as Array<EventLogEntry & { seq: number }>;
    expect(served).toHaveLength(1);
    expect(r.page).toEqual({
      after_seq: page.after_seq,
      next_seq: page.next_seq,
      has_more: page.has_more,
      latest_seq: page.latest_seq,
    });
    expect(r.page).toEqual({ after_seq: 1, next_seq: 2, has_more: true, latest_seq: 3 });
    const { seq, ...servedEntry } = served[0]!;
    expect(r.events).toEqual([
      {
        event_id: servedEntry.event_id,
        digest: await computeSyncEventDigest(servedEntry),
        redacted: false,
        seq,
      },
    ]);
    expect(await verifySyncHoldReceipt(r, pinned(mid))).toEqual({ valid: true });

    // An impostor replaying this page as the answer to a lower cursor, or
    // stretching its top, cannot keep the relay's signature.
    for (const p of [
      { ...r.page!, after_seq: 0 },
      { ...r.page!, next_seq: 3 },
      { ...r.page!, has_more: false },
      { ...r.page!, latest_seq: 2 },
    ]) {
      expect(
        (await verifySyncHoldReceipt({ ...r, page: p }, pinned(mid))).valid,
        JSON.stringify(p),
      ).toBe(false);
    }

    // An empty page is signed too (nothing above the cursor).
    const empty = await pullSeq(mid, "after_seq=3");
    expect(receiptOf(empty).events).toEqual([]);
    expect(receiptOf(empty).page).toEqual({
      after_seq: 3,
      next_seq: 3,
      has_more: false,
      latest_seq: 3,
    });
    expect(
      (
        await verifySyncHoldReceipt(receiptOf(empty), {
          ...pinned(mid),
          expectedPublicKey: relayKey,
        })
      ).valid,
    ).toBe(true);
  });
});

describe("(e) digest + redacted describe what the relay holds", () => {
  it("a redacted event is redacted=true with the stored bytes' digest; a benign one hashes as pushed", async () => {
    const mid = crypto.randomUUID();
    const medical = entry(mid, {
      event_type: EventType.MemoryFormed,
      payload: { node_id: "n1", content: "diagnosis", sensitivity: "medical" },
    });
    const benign = entry(mid);
    const r = receiptOf((await push(mid, [medical, benign], NONCE)).body);

    const page = await pullSeq(mid, "after_seq=0");
    const byId = new Map(
      (page.events as Array<EventLogEntry & { seq: number }>).map(({ seq: _s, ...e }) => [
        e.event_id,
        e,
      ]),
    );
    const heldMedical = r.events.find((e) => e.event_id === medical.event_id)!;
    expect(heldMedical.redacted).toBe(true);
    expect((byId.get(medical.event_id)!.payload as Record<string, unknown>).content).toBe(
      "[REDACTED]",
    );
    expect(heldMedical.digest).toBe(await computeSyncEventDigest(byId.get(medical.event_id)));
    expect(heldMedical.digest).not.toBe(await computeSyncEventDigest(medical));

    const heldBenign = r.events.find((e) => e.event_id === benign.event_id)!;
    expect(heldBenign.redacted).toBe(false);
    // A client holding the bytes it pushed can recompute the digest itself.
    expect(heldBenign.digest).toBe(await computeSyncEventDigest(benign));

    // The page receipt agrees with the push receipt on what is held.
    const pageReceipt = receiptOf(page);
    for (const h of r.events) {
      const p = pageReceipt.events.find((e) => e.event_id === h.event_id)!;
      expect({ digest: p.digest, redacted: p.redacted }).toEqual({
        digest: h.digest,
        redacted: h.redacted,
      });
    }
  });

  it("older end-to-end ciphertext held for an id is described as stored, not as re-pushed", async () => {
    const mid = crypto.randomUUID();
    const v1 = entry(mid, { payload: { _encrypted: true, ciphertext: "old-bytes" } });
    await push(mid, [v1]);
    const v2 = { ...v1, payload: { _encrypted: true, ciphertext: "new-bytes" } };
    const r = receiptOf((await push(mid, [v2], NONCE)).body);
    expect(r.events).toEqual([
      { event_id: v1.event_id, digest: await computeSyncEventDigest(v1), redacted: false },
    ]);
    expect(r.events[0]!.digest).not.toBe(await computeSyncEventDigest(v2));
  });
});

describe("(f) existing clients see every old field unchanged", () => {
  it("HTTP push, duplicate push, seq pull, clock pull and WS ack", async () => {
    const mid = crypto.randomUUID();
    const a = entry(mid);
    const first = await push(mid, [a]);
    const { hold_receipt: _1, ...firstOld } = first.body;
    expect(firstOld).toEqual({ motebit_id: mid, accepted: 1, duplicates: 0 });

    const receipt = { signature: `sig-${crypto.randomUUID()}` };
    await push(mid, [entry(mid, { payload: { receipt } })]);
    const dup = await push(mid, [entry(mid, { payload: { receipt } })]);
    const { hold_receipt: _2, ...dupOld } = dup.body;
    expect(dupOld).toEqual({ motebit_id: mid, accepted: 0, duplicate: true });

    const page = await pullSeq(mid, "after_seq=0");
    const { hold_receipt: _3, ...pageOld } = page;
    expect(Object.keys(pageOld).sort()).toEqual(
      ["after_seq", "events", "has_more", "latest_seq", "motebit_id", "next_seq"].sort(),
    );
    expect((pageOld.events as EventLogEntry[])[0]).toEqual({ ...a, seq: 1 });

    // The clock pull is served exactly as before — no receipt at all.
    const clockRes = await relay.app.request(`/sync/${mid}/pull?after_clock=0`, {
      headers: AUTH_HEADER,
    });
    const clockBody = (await clockRes.json()) as Record<string, unknown>;
    expect(Object.keys(clockBody).sort()).toEqual(["after_clock", "events", "motebit_id"]);

    const ack = await wsPush(mid, { push_id: "f1", events: [entry(mid)] });
    const { hold_receipt: _4, ...ackOld } = ack;
    expect(ackOld).toEqual({ type: "ack", accepted: 1, push_id: "f1" });
  });
});
