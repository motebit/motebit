/**
 * #962 round 7 — `motebit sync status`, `motebit status`, the REPL notice and
 * `motebit sync retire` are tie-aware.
 *
 * Two dead streams tied at the floor (two typo'd relays at 0 beside the right
 * relay at 90; two old relays at 50) each free nothing when retired alone,
 * so round 6 printed no notice and `sync status` said retiring "frees
 * nothing" — the floor was pinned, silently. The notice now names every
 * stream in the tied set and what retiring all of them frees.
 *
 * Driven over a real `motebit.db` through the CLI's own command module.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-962r7-cfg-"));
});

import { EventType } from "@motebit/sdk";
import { openMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import {
  pushAckedAtKey,
  pushCompactionFloor,
  recordSyncIntent,
  resolveSeqCursorStore,
} from "@motebit/sync-engine";
import { pinnedFloorNotice, runSyncCommand, statusLines } from "../subcommands/sync.js";
import type { SyncCommandContext } from "../subcommands/sync.js";

const MID = "mote-962r7-cli";
const TYPO1 = "https://typo1.invalid";
const TYPO2 = "https://typo2.invalid";
const OLD1 = "https://old1.relay";
const OLD2 = "https://old2.relay";
const RIGHT = "http://relay.right";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);

async function withDb<T>(path: string, fn: (db: MotebitDatabase) => Promise<T>): Promise<T> {
  const db = await openMotebitDatabase(path);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** 100 events; each relay's acked cursor (and, optionally, when it last acked). */
async function scenario(
  cursors: Record<string, number>,
  ackedAt: Record<string, number> = {},
): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "motebit-962r7-db-")), "motebit.db");
  await withDb(path, async (db) => {
    await recordSyncIntent(db.eventStore, MID);
    for (let i = 0; i < 100; i++) {
      await db.eventStore.appendWithClock!({
        event_id: crypto.randomUUID(),
        motebit_id: MID as never,
        timestamp: Date.now(),
        event_type: EventType.StateUpdated,
        payload: { i },
        tombstoned: false,
      });
    }
    const cs = resolveSeqCursorStore(db.eventStore);
    for (const [url, v] of Object.entries(cursors)) {
      await cs.setSyncSeqCursor(`push:raw:${url}#${MID}`, v);
    }
    for (const [url, at] of Object.entries(ackedAt)) {
      await cs.setSyncSeqCursor(pushAckedAtKey(`${url}#${MID}`), at);
    }
  });
  return path;
}

const typoTie = (): Promise<string> => scenario({ [TYPO1]: 0, [TYPO2]: 0, [RIGHT]: 90 });
const staleTie = (): Promise<string> =>
  scenario(
    { [OLD1]: 50, [OLD2]: 50, [RIGHT]: 90 },
    { [OLD1]: NOW - 9 * DAY, [OLD2]: NOW - 8 * DAY, [RIGHT]: NOW - DAY },
  );

function ctx(path: string, over: Partial<SyncCommandContext> = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const c: SyncCommandContext = {
    dbPath: path,
    motebitId: MID,
    configuredUrl: RIGHT,
    force: false,
    yes: false,
    now: NOW,
    confirm: (q) => {
      asked.push(q);
      return Promise.resolve(true);
    },
    print: (l) => lines.push(l),
    ...over,
  };
  return { c, lines, asked };
}

for (const [shape, make, a, b, frees] of [
  ["two typo'd relays tied at 0, the right relay at 90", typoTie, TYPO1, TYPO2, 90],
  ["two old relays tied at 50 (stale), the right relay at 90", staleTie, OLD1, OLD2, 40],
] as const) {
  describe(`#962 round 7 — ${shape}`, () => {
    it("motebit sync status: each tied stream says retiring ALL of them frees the gap, never 'frees nothing'", async () => {
      const path = await make();
      const { c, lines } = ctx(path);
      expect(await runSyncCommand("status", [], c)).toBe(0);
      const out = lines.join("\n");
      expect(out).not.toMatch(/frees nothing/);
      for (const url of [a, b]) {
        const line = lines.find((l) => l.includes(url) && l.includes("acked clock"));
        expect(line).toMatch(/holds the floor/);
        expect(line).toMatch(/tied/);
        expect(line).toContain(`${frees} events`);
      }
      // The notice names every stream in the tied set, with a retire for each.
      expect(out).toContain(`motebit sync retire ${a}`);
      expect(out).toContain(`motebit sync retire ${b}`);
      console.info(`\n--- motebit sync status (${shape}) ---\n${out}\n---`);
    });

    it("motebit status and the REPL notice: one line naming both streams and the events they hold", async () => {
      const path = await make();
      const lines = await statusLines({
        dbPath: path,
        motebitId: MID,
        configuredUrl: RIGHT,
        now: NOW,
      });
      const notices = lines.filter((l) => l.includes("motebit sync retire"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(a);
      expect(notices[0]).toContain(b);
      expect(notices[0]).toContain(`${frees} events`);
      const notice = await withDb(path, (db) => pinnedFloorNotice(db.eventStore, MID, RIGHT, NOW));
      expect(notice).toBe(notices[0]!.trim());
    });

    it("motebit sync retire on one twin says it frees nothing alone and names the twin; both free the gap", async () => {
      const path = await make();
      const first = ctx(path);
      expect(await runSyncCommand("retire", [a], first.c)).toBe(0);
      expect(first.asked[0]).toContain(b);
      expect(first.asked[0]).toContain(`${frees} events`);
      const second = ctx(path);
      expect(await runSyncCommand("retire", [b], second.c)).toBe(0);
      expect(second.lines.join("\n")).toMatch(new RegExp(`free[s]? ${frees} events`));
      await withDb(path, async (db) => {
        expect(await pushCompactionFloor(db.eventStore, 99, { motebitId: MID })).toBe(100 - 10);
      });
    });
  });
}
