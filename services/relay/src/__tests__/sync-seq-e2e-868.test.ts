/**
 * #868 round 2 — the E2E socket catch-up path, exhaustively.
 *
 * Every WS surface (desktop, web, spatial, mobile-WS) catches up through
 * `WebSocketEventStoreAdapter.catchUp` over `EncryptedEventStoreAdapter(Http)`.
 * The round-1 client decrypted a whole seq page with one `Promise.all` before
 * dedup, so ONE event the device could not decrypt stopped the cursor for
 * good — and after an identity-key rotation every pre-rotation event is such
 * an event, re-read from seq 0 on the upgrade's first pull.
 *
 * Real relay, real `WebSocketEventStoreAdapter` + `EncryptedEventStoreAdapter`
 * + `HttpEventStoreAdapter` (sync-engine source), a real persistence (SQLite)
 * local store that keeps the cursor and the skipped-event record. The socket
 * is a fake that opens at once; a catch-up is a fresh adapter each time (a
 * reconnect / token refresh), so the persisted cursor is exercised too.
 *
 * Alphabet (every sequence of LENGTH over five letters, then a final C):
 *   W  the writer device writes an event under the CURRENT sync key
 *   L  a lagging sibling that never rotated writes under the OLD key (k1)
 *   P  a poison event: an E2E envelope no key opens
 *   R  identity-key rotation: the current key becomes k2 for the writer and
 *      the reader; the reader no longer holds k1 (deriveSyncEncryptionKey
 *      derives from the current identity key only)
 *   C  the reader catches up (a new socket adapter over the same store)
 *
 * Asserted per run, after the final C:
 *   - every event is ACCOUNTED FOR: held (decrypted) or recorded as skipped,
 *     never both, never neither — nothing is lost silently;
 *   - every event written under a key the reader holds at the end is HELD —
 *     so a poison or undecryptable event never stops the stream behind it;
 *   - every poison event is recorded `undecryptable` with its seq;
 *   - no held payload is ciphertext, and each held payload is the plaintext
 *     written;
 *   - an event held before a rotation stays held and is never decrypted again.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { SyncRelay } from "../index.js";
import { createTestRelay, API_TOKEN } from "./test-helpers.js";

interface WsAdapterLike {
  connect(): void;
  disconnect(): void;
}
interface SyncEngineModule {
  HttpEventStoreAdapter: new (cfg: {
    baseUrl: string;
    motebitId: string;
    authToken?: string;
    maxRetries?: number;
  }) => EventStoreAdapter;
  EncryptedEventStoreAdapter: new (cfg: {
    inner: EventStoreAdapter;
    key: Uint8Array;
  }) => EventStoreAdapter;
  WebSocketEventStoreAdapter: new (cfg: {
    url: string;
    motebitId: string;
    httpFallback: EventStoreAdapter;
    localStore: EventStoreAdapter;
    onCatchUp?: (n: number) => void;
    onSkippedEvent?: (s: unknown) => void;
  }) => WsAdapterLike;
}

const BASE = "http://relay.zz868e2e.test";
let relay: SyncRelay;
let se: SyncEngineModule;

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(): void {}
  close(): void {}
}

beforeAll(async () => {
  se = (await import(
    /* @vite-ignore */ fileURLToPath(
      new URL("../../../../packages/sync-engine/src/index.ts", import.meta.url),
    )
  )) as SyncEngineModule;
  relay = await createTestRelay({ enableDeviceAuth: true });
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    return relay.app.request(url.pathname + url.search, init);
  });
  vi.stubGlobal("WebSocket", FakeSocket);
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await relay.close();
}, 60_000);

const K1 = new Uint8Array(32).fill(1);
const K2 = new Uint8Array(32).fill(2);
const KX = new Uint8Array(32).fill(99); // nobody holds it

type Letter = "W" | "L" | "P" | "R" | "C";
const LENGTH = Number(process.env.ZZ868_E2E_LEN ?? 5);

interface Written {
  id: string;
  key: "k1" | "k2" | "poison";
}

class Run {
  readonly mid = crypto.randomUUID();
  readonly reader: MotebitDatabase = createMotebitDatabase(":memory:");
  readonly http = new se.HttpEventStoreAdapter({
    baseUrl: BASE,
    motebitId: this.mid,
    authToken: API_TOKEN,
    maxRetries: 0,
  });
  rotated = false;
  clock = 0;
  written: Written[] = [];
  heldBeforeRotation = new Set<string>();

  private entry(id: string): EventLogEntry {
    this.clock++;
    return {
      event_id: `${id}-${this.mid}`,
      motebit_id: this.mid as EventLogEntry["motebit_id"],
      timestamp: 1_700_000_000_000 + this.clock,
      event_type: "state_snapshot" as EventLogEntry["event_type"],
      payload: { plain: id },
      version_clock: this.clock,
      tombstoned: false,
    };
  }

  async write(kind: "W" | "L" | "P"): Promise<void> {
    const n = this.written.length + 1;
    const key = kind === "P" ? KX : kind === "L" ? K1 : this.rotated ? K2 : K1;
    const tag = kind === "P" ? "poison" : kind === "L" ? "k1" : this.rotated ? "k2" : "k1";
    const e = this.entry(`${kind}${n}`);
    await new se.EncryptedEventStoreAdapter({ inner: this.http, key }).append(e);
    this.written.push({ id: e.event_id, key: tag });
  }

  rotate(): void {
    if (this.rotated) return;
    for (const id of this.heldIds()) this.heldBeforeRotation.add(id);
    this.rotated = true;
  }

  async catchUp(): Promise<void> {
    const enc = new se.EncryptedEventStoreAdapter({
      inner: this.http,
      key: this.rotated ? K2 : K1,
    });
    let done = -1;
    const ws = new se.WebSocketEventStoreAdapter({
      url: `ws://relay.zz868e2e.test/ws/sync/${this.mid}`,
      motebitId: this.mid,
      httpFallback: enc,
      localStore: this.reader.eventStore,
      onCatchUp: (n) => (done = n),
      onSkippedEvent: () => {},
    });
    ws.connect();
    FakeSocket.last!.onopen?.();
    await vi.waitFor(() => expect(done).toBeGreaterThanOrEqual(0), { timeout: 5000, interval: 1 });
    ws.disconnect();
  }

  heldIds(): string[] {
    return (
      this.reader.db.prepare("SELECT event_id FROM events ORDER BY event_id").all() as Array<{
        event_id: string;
      }>
    ).map((r) => r.event_id);
  }

  skipped(): Array<{ event_id: string; seq: number | null; reason: string }> {
    return this.reader.db
      .prepare("SELECT event_id, seq, reason FROM sync_skipped_events ORDER BY event_id")
      .all() as Array<{ event_id: string; seq: number | null; reason: string }>;
  }
}

function sequences(n: number): Letter[][] {
  const letters: Letter[] = ["W", "L", "P", "R", "C"];
  let out: Letter[][] = [[]];
  for (let i = 0; i < n; i++) out = out.flatMap((s) => letters.map((l) => [...s, l]));
  return out;
}

async function runSequence(seq: Letter[]): Promise<string | null> {
  const r = new Run();
  try {
    for (const l of seq) {
      if (l === "R") r.rotate();
      else if (l === "C") await r.catchUp();
      else await r.write(l);
    }
    await r.catchUp();
    const held = new Set(r.heldIds());
    const skipped = r.skipped();
    const skippedIds = new Set(skipped.map((s) => s.event_id));
    const readerKey = r.rotated ? "k2" : "k1";
    for (const w of r.written) {
      const h = held.has(w.id);
      const s = skippedIds.has(w.id);
      if (h === s) return `${w.id} ${h ? "both held and skipped" : "neither held nor recorded"}`;
      if (w.key === readerKey && !h)
        return `${w.id} (${w.key}) decryptable at the end but not held`;
      if (w.key === "poison" && !s) return `${w.id} poison not recorded`;
    }
    for (const s of skipped) {
      if (s.reason !== "undecryptable" || typeof s.seq !== "number") {
        return `bad skip record ${JSON.stringify(s)}`;
      }
    }
    for (const id of r.heldBeforeRotation) if (!held.has(id)) return `${id} lost after rotation`;
    const rows = r.reader.db.prepare("SELECT event_id, payload FROM events").all() as Array<{
      event_id: string;
      payload: string;
    }>;
    for (const row of rows) {
      const p = JSON.parse(row.payload) as Record<string, unknown>;
      if (p._encrypted === true) return `${row.event_id} held as ciphertext`;
      if (typeof p.plain !== "string" || !row.event_id.startsWith(p.plain)) {
        return `${row.event_id} payload is not what was written`;
      }
    }
    return null;
  } finally {
    r.reader.close();
  }
}

describe("#868 E2E socket catch-up matrix: rotation and poison never stop the stream", () => {
  it(`all ${5 ** LENGTH} orderings of length ${LENGTH} over {W,L,P,R,C} account for every event`, async () => {
    const failures: string[] = [];
    for (const seq of sequences(LENGTH)) {
      const why = await runSequence(seq);
      if (why) failures.push(`${seq.join(">")}: ${why}`);
    }
    expect(failures.slice(0, 5), `${failures.length} failing orderings`).toEqual([]);
  }, 900_000);

  it("rotatedWs: an event held before rotation is never decrypted again, and the post-rotation event arrives", async () => {
    const r = new Run();
    try {
      await r.write("W"); // old-1 under k1
      await r.catchUp(); // held
      r.rotate();
      await r.write("W"); // new-2 under k2
      await r.catchUp(); // first catch-up after rotation (a new client starts at seq 0)
      expect(r.heldIds()).toEqual(r.written.map((w) => w.id).sort());
      expect(r.skipped()).toEqual([]);
    } finally {
      r.reader.close();
    }
  });

  it("poisonWs: a poison event is recorded with its seq and the sibling event behind it arrives", async () => {
    const r = new Run();
    try {
      await r.write("P");
      await r.write("W");
      await r.catchUp();
      const [poison, sib] = r.written;
      expect(r.heldIds()).toEqual([sib!.id]);
      expect(r.skipped()).toEqual([{ event_id: poison!.id, seq: 1, reason: "undecryptable" }]);
    } finally {
      r.reader.close();
    }
  });
});
