/**
 * #868 interleaving harness — the REAL relay and the REAL sync client
 * (`@motebit/sync-engine`'s `SyncEngine` + `HttpEventStoreAdapter`, loaded
 * from source), two devices of ONE identity, every ordering of a small action
 * alphabet enumerated exhaustively.
 *
 * The #816 lesson: prove a sync fix with a harness over orderings, not case by
 * case. The defect (#868): the pull cursor was the device's own max
 * `version_clock`; clocks are device-assigned, so a sibling device's event at
 * an equal (or lower) clock was never pulled.
 *
 * Alphabet (per run, a sequence of LENGTH actions over five letters):
 *   A+ / B+   the device appends a local event (`appendWithClock`, as the
 *             runtime does — so clocks collide, lead and trail naturally)
 *   AS / BS   the device runs one `SyncEngine.sync()` (push, then pull)
 *   D         one disturbance, fixed per matrix row:
 *               AR / BR  client restart — a NEW SyncEngine over the same
 *                        local store (clock cursor back to 0; the seq cursor
 *                        survives only if the store persists it)
 *               RR       relay restart on the same database file
 *               RM       relay upgrade: the identity's stream was served by a
 *                        pre-#868 relay (clock only — `after_seq` ignored)
 *                        until this action, and by seq after it
 *
 * Device kinds:
 *   new-persist   the new client over a persistence (SQLite) local store,
 *                 which persists the seq cursor beside its events
 *   new-volatile  the new client over a local store that cannot persist a
 *                 cursor, re-wrapped on every client restart (a new process:
 *                 the cursor restarts at 0, deduped by event_id)
 *   old           the SHIPPED client: a remote without `pullAfterSeq`, so the
 *                 SyncEngine takes its unchanged pre-#868 clock path
 *
 * After the sequence: the relay is upgraded if it was not, then at most
 * FINAL_ROUNDS rounds of (A sync, B sync). Asserted per run:
 *   - every new-client device holds EVERY event of both devices, exactly
 *     once, within the bounded rounds;
 *   - its `pulled` counts sum to exactly the foreign events it holds (no
 *     event counted twice);
 *   - every device's own events reached the relay (old clients included);
 *   - no device ever holds an event of another identity.
 *
 * RM is simulated per identity (`after_seq` stripped from that identity's
 * pulls until the upgrade), not by re-running v46: the trigger stamps rows in
 * insertion order, which is exactly the order v46's backfill (`ORDER BY
 * rowid` over an append-only table) assigns. The real migration is proven in
 * `event-seq-868.test.ts` (backfill order, upgrade at boot).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { SyncRelay } from "../index.js";
import { createTestRelay, API_TOKEN } from "./test-helpers.js";

// ── the real client, from source ────────────────────────────────────────────
interface SyncResultLike {
  pushed: number;
  pulled: number;
}
interface SyncEngineLike {
  connectRemote(remote: EventStoreAdapter): void;
  sync(): Promise<SyncResultLike>;
  getStatus(): string;
}
interface SyncEngineModule {
  SyncEngine: new (local: EventStoreAdapter, motebitId: string) => SyncEngineLike;
  HttpEventStoreAdapter: new (cfg: {
    baseUrl: string;
    motebitId: string;
    authToken?: string;
    maxRetries?: number;
  }) => EventStoreAdapter;
}
const SYNC_ENGINE_SRC = fileURLToPath(
  new URL("../../../../packages/sync-engine/src/index.ts", import.meta.url),
);
let se: SyncEngineModule;

// ── one relay for the whole matrix; each run is its own identity ────────────
const BASE = "http://relay.zz868.test";
let relay: SyncRelay;
let dir: string;
let dbPath: string;
/** Identities still served by a pre-#868 relay (no seq): `after_seq` is stripped. */
const legacy = new Set<string>();

async function restartRelay(): Promise<void> {
  await relay.close();
  relay = await createTestRelay({ dbPath, enableDeviceAuth: true });
}

beforeAll(async () => {
  se = (await import(/* @vite-ignore */ SYNC_ENGINE_SRC)) as SyncEngineModule;
  dir = mkdtempSync(join(tmpdir(), "zz868-matrix-"));
  dbPath = join(dir, "relay.db");
  relay = await createTestRelay({ dbPath, enableDeviceAuth: true });
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const mid = url.pathname.split("/")[2] ?? "";
    if (legacy.has(mid) && url.pathname.endsWith("/pull")) url.searchParams.delete("after_seq");
    return relay.app.request(url.pathname + url.search, init);
  });
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

// ── devices ─────────────────────────────────────────────────────────────────
type Kind = "new-persist" | "new-volatile" | "old";

/** A local store that cannot persist a cursor: delegates events, nothing else. */
function volatileView(inner: EventStoreAdapter): EventStoreAdapter {
  return {
    append: (e) => inner.append(e),
    appendWithClock: (e) => inner.appendWithClock!(e),
    query: (f) => inner.query(f),
    getLatestClock: (m) => inner.getLatestClock(m),
    tombstone: (id, m) => inner.tombstone(id, m),
  };
}

/** The shipped client's remote: HTTP without `pullAfterSeq`, so SyncEngine takes the clock path. */
function oldRemote(http: EventStoreAdapter): EventStoreAdapter {
  return {
    append: (e) => http.append(e),
    query: (f) => http.query(f),
    getLatestClock: (m) => http.getLatestClock(m),
    tombstone: (id, m) => http.tombstone(id, m),
  };
}

class Device {
  readonly db: MotebitDatabase = createMotebitDatabase(":memory:");
  engine!: SyncEngineLike;
  local!: EventStoreAdapter;
  pulled = 0;
  own: string[] = [];
  constructor(
    readonly name: string,
    readonly kind: Kind,
    readonly mid: string,
  ) {
    this.boot();
  }
  /** A fresh client process over the same local data. */
  boot(): void {
    this.local =
      this.kind === "new-volatile" ? volatileView(this.db.eventStore) : this.db.eventStore;
    this.engine = new se.SyncEngine(this.local, this.mid);
    const http = new se.HttpEventStoreAdapter({
      baseUrl: BASE,
      motebitId: this.mid,
      authToken: API_TOKEN,
      maxRetries: 0,
    });
    this.engine.connectRemote(this.kind === "old" ? oldRemote(http) : http);
  }
  async append(): Promise<void> {
    // `event_id` is the relay's GLOBAL primary key, so it carries the run's identity.
    const id = `${this.name}-${this.own.length + 1}-${this.mid}`;
    this.own.push(id);
    await this.db.eventStore.appendWithClock({
      event_id: id,
      motebit_id: this.mid as EventLogEntry["motebit_id"],
      timestamp: 1_700_000_000_000 + this.own.length,
      event_type: "state_snapshot" as EventLogEntry["event_type"],
      payload: { by: this.name },
      tombstoned: false,
    });
  }
  async sync(): Promise<void> {
    const r = await this.engine.sync();
    expect(this.engine.getStatus(), `${this.name} sync status`).toBe("idle");
    this.pulled += r.pulled;
  }
  ids(): string[] {
    return (
      this.db.db.prepare("SELECT event_id FROM events ORDER BY event_id").all() as Array<{
        event_id: string;
      }>
    ).map((r) => r.event_id);
  }
}

type Letter = "A+" | "AS" | "B+" | "BS" | "D";
type Disturbance = "AR" | "BR" | "RR" | "RM";
const LENGTH = Number(process.env.ZZ868_LEN ?? 4);
const FINAL_ROUNDS = 2;

function sequences(n: number): Letter[][] {
  const letters: Letter[] = ["A+", "AS", "B+", "BS", "D"];
  let out: Letter[][] = [[]];
  for (let i = 0; i < n; i++) out = out.flatMap((s) => letters.map((l) => [...s, l]));
  return out;
}

interface RunResult {
  ok: boolean;
  why?: string;
  relayRestarts: number;
}

async function run(seq: Letter[], kindA: Kind, kindB: Kind, d: Disturbance): Promise<RunResult> {
  const mid = crypto.randomUUID();
  if (d === "RM") legacy.add(mid);
  const A = new Device("a", kindA, mid);
  const B = new Device("b", kindB, mid);
  let relayRestarts = 0;
  try {
    for (const l of seq) {
      if (l === "A+") await A.append();
      else if (l === "B+") await B.append();
      else if (l === "AS") await A.sync();
      else if (l === "BS") await B.sync();
      else if (d === "AR") A.boot();
      else if (d === "BR") B.boot();
      else if (d === "RM") legacy.delete(mid);
      else {
        await restartRelay();
        relayRestarts++;
      }
    }
    legacy.delete(mid); // the relay is upgraded before convergence is judged
    for (let round = 0; round < FINAL_ROUNDS; round++) {
      await A.sync();
      await B.sync();
    }
    const all = [...A.own, ...B.own].sort();
    const relayIds = (
      relay.moteDb.db
        .prepare("SELECT event_id FROM events WHERE motebit_id = ? ORDER BY event_id")
        .all(mid) as Array<{ event_id: string }>
    ).map((r) => r.event_id);
    if (JSON.stringify(relayIds) !== JSON.stringify(all)) {
      return {
        ok: false,
        why: `relay holds ${relayIds.join(",")} ≠ appended ${all.join(",")}`,
        relayRestarts,
      };
    }
    for (const dev of [A, B]) {
      const held = dev.ids();
      const foreign = dev.db.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE motebit_id <> ?")
        .get(mid) as { n: number };
      if (foreign.n !== 0)
        return { ok: false, why: `${dev.name} holds a foreign event`, relayRestarts };
      if (dev.kind === "old") continue;
      if (JSON.stringify(held) !== JSON.stringify(all)) {
        return {
          ok: false,
          why: `${dev.name} (${dev.kind}) holds [${held.join(",")}] ≠ all [${all.join(",")}]`,
          relayRestarts,
        };
      }
      const other = dev === A ? B : A;
      if (dev.pulled !== other.own.length) {
        return {
          ok: false,
          why: `${dev.name} counted ${dev.pulled} pulled for ${other.own.length} foreign events`,
          relayRestarts,
        };
      }
    }
    return { ok: true, relayRestarts };
  } finally {
    legacy.delete(mid);
    A.db.close();
    B.db.close();
  }
}

describe("#868 interleaving matrix: real relay × real SyncEngine, every ordering", () => {
  const ALL = sequences(LENGTH);
  const MATRIX: Array<{ a: Kind; b: Kind; d: Disturbance }> = [
    { a: "new-persist", b: "new-persist", d: "AR" },
    { a: "new-persist", b: "new-persist", d: "RM" },
    { a: "new-volatile", b: "new-persist", d: "AR" },
    { a: "new-volatile", b: "new-volatile", d: "BR" },
    { a: "new-persist", b: "old", d: "BR" },
    { a: "old", b: "new-volatile", d: "RM" },
    { a: "new-persist", b: "new-volatile", d: "RR" },
  ];

  for (const { a, b, d } of MATRIX) {
    it(`A=${a} B=${b} D=${d}: all ${ALL.length} orderings of length ${LENGTH} converge exactly once`, async () => {
      const failures: string[] = [];
      let restarts = 0;
      for (const seq of ALL) {
        const r = await run(seq, a, b, d);
        restarts += r.relayRestarts;
        if (!r.ok) failures.push(`${seq.join(">")}: ${r.why}`);
      }
      expect(failures.slice(0, 5), `${failures.length} failing orderings`).toEqual([]);
      if (d === "RR") expect(restarts).toBeGreaterThan(0);
    }, 600_000);
  }

  it("the orderings include the #868 trace shape: both devices append at an equal clock and one pulls before the other's event lands", () => {
    const joined = ALL.map((s) => s.join(">"));
    expect(joined).toContain("A+>AS>B+>BS");
    expect(joined).toContain("A+>B+>AS>BS");
  });
});
