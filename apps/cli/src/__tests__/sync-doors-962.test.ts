/**
 * #962 round 6 — a pinned compaction floor is never SILENT or DOORLESS, and
 * relay text never reaches the terminal raw.
 *
 * C1: `connectRemote` persists `push:<stream>=0` for any relay it touches and
 * the floor is the MIN over the identity's streams, so one `motebit run
 * --sync-url https://typo`, or a relay switch, pinned compaction for good.
 * A stream is never auto-retired (a relay that has not acked is not proof
 * it never will); the operator gets doors: `motebit sync status`, `motebit
 * sync retire <relay-url>`, `motebit sync clear-intent` — confirm-before-act,
 * each recorded as an event — and a pinned floor is said once, at REPL start
 * and in `motebit status`.
 *
 * C2: `/sync` printed `getLastError().message` raw and uncapped.
 * P3: no command cleared the sync intent.
 *
 * Driven over a real `motebit.db` (SQLite, separate opens = separate
 * processes) through the CLI's own command module.
 */
import { mkdtempSync, readFileSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-962r6-cfg-"));
});

import ts from "typescript";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { openMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import {
  HttpEventStoreAdapter,
  SyncEngine,
  pushCompactionFloor,
  readSyncIntent,
  recordSyncIntent,
  resolveSeqCursorStore,
} from "@motebit/sync-engine";
import type { SyncEngine as SyncEngineType, SyncResult } from "@motebit/sync-engine";
import { handleSlashCommand } from "../slash-commands.js";
import { parseCliArgs } from "../args.js";
import * as cliEventPush from "../cli-event-push.js";

const MID = "mote-962r6-cli";
const TYPO = "https://typo.invalid";
const RIGHT = "http://relay.right";

interface SyncCommandContext {
  dbPath: string;
  motebitId: string;
  configuredUrl: string | undefined;
  force: boolean;
  yes: boolean;
  json?: boolean;
  confirm: (question: string) => Promise<boolean>;
  print: (line: string) => void;
  now?: number;
}
interface SyncModule {
  runSyncCommand(sub: string, args: string[], ctx: SyncCommandContext): Promise<number>;
  statusLines(ctx: {
    dbPath: string;
    motebitId: string;
    configuredUrl: string | undefined;
    now?: number;
  }): Promise<string[]>;
  pinnedFloorNotice(
    store: MotebitDatabase["eventStore"],
    motebitId: string,
    configuredUrl: string | undefined,
    now?: number,
  ): Promise<string | null>;
}

/** The round-6 command module; absent before the fix (red). */
async function syncModule(): Promise<SyncModule> {
  const path = "../subcommands/sync.js";
  return (await import(/* @vite-ignore */ path)) as SyncModule;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "motebit-962r6-db-")), "motebit.db");
}

async function withDb<T>(path: string, fn: (db: MotebitDatabase) => Promise<T>): Promise<T> {
  const db = await openMotebitDatabase(path);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function appendEvents(db: MotebitDatabase, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.eventStore.appendWithClock!({
      event_id: crypto.randomUUID(),
      motebit_id: MID as never,
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: { i },
      tombstoned: false,
    });
  }
}

/**
 * The reviewer's C1 probe on a real motebit.db: process 1 connects sync to a
 * typo'd relay once and stops; process 2 appends 20; the right relay acked 10.
 */
async function typoScenario(): Promise<string> {
  const path = dbPath();
  await withDb(path, async (db) => {
    const engine = new SyncEngine(db.eventStore, MID);
    engine.connectRemote(new HttpEventStoreAdapter({ baseUrl: TYPO, motebitId: MID }));
    await recordSyncIntent(db.eventStore, MID);
    await new Promise((r) => setTimeout(r, 0));
  });
  await withDb(path, async (db) => {
    await appendEvents(db, 20);
    await resolveSeqCursorStore(db.eventStore).setSyncSeqCursor(`push:raw:${RIGHT}#${MID}`, 10);
  });
  return path;
}

function ctx(path: string, over: Partial<SyncCommandContext> = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const c: SyncCommandContext = {
    dbPath: path,
    motebitId: MID,
    configuredUrl: RIGHT,
    force: false,
    yes: false,
    confirm: (q) => {
      asked.push(q);
      return Promise.resolve(true);
    },
    print: (l) => lines.push(l),
    ...over,
  };
  return { c, lines, asked };
}

async function auditEvents(path: string): Promise<EventLogEntry[]> {
  return withDb(path, (db) =>
    db.eventStore.query({ motebit_id: MID as never, event_types: [EventType.AuditEntry] }),
  );
}

describe("#962 round 6 C1 — motebit sync status reports the pinned stream", () => {
  it("the typo scenario: the typo'd stream holds the floor, with the events it holds back", async () => {
    const path = await typoScenario();
    const { runSyncCommand } = await syncModule();
    const { c, lines } = ctx(path);
    expect(await runSyncCommand("status", [], c)).toBe(0);
    const out = lines.join("\n");
    const typoLine = lines.find((l) => l.includes(TYPO));
    const rightLine = lines.find((l) => l.includes(RIGHT) && !l.includes("Configured"));
    expect(typoLine).toMatch(/acked clock 0/);
    expect(typoLine).toMatch(/never/);
    expect(typoLine).toMatch(/holds the floor/i);
    expect(typoLine).toMatch(/10 events held back/);
    expect(rightLine).toMatch(/acked clock 10/);
    expect(rightLine).not.toMatch(/holds the floor/i);
    expect(out).toContain(`motebit sync retire ${TYPO}`);
    // Printed for the report.
    console.info(`\n--- motebit sync status (typo scenario) ---\n${out}\n---`);
  });

  it("--json carries the same report", async () => {
    const path = await typoScenario();
    const { runSyncCommand } = await syncModule();
    const { c, lines } = ctx(path, { json: true });
    expect(await runSyncCommand("status", [], c)).toBe(0);
    const report = JSON.parse(lines.join("\n")) as {
      floor: number;
      streams: Array<{ relayUrl: string; holdsFloor: boolean; heldBack: number }>;
    };
    expect(report.floor).toBe(0);
    expect(report.streams.find((s) => s.relayUrl === TYPO)).toMatchObject({
      holdsFloor: true,
      heldBack: 10,
    });
  });
});

describe("#962 round 6 C1 — the pinned floor is said once: REPL start and motebit status", () => {
  it("motebit status: one line naming the stream and the retire command", async () => {
    const path = await typoScenario();
    const { statusLines } = await syncModule();
    const lines = await statusLines({ dbPath: path, motebitId: MID, configuredUrl: RIGHT });
    const notices = lines.filter((l) => l.includes("motebit sync retire"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(TYPO);
  });

  it("REPL start: replStartupSync prints the notice once, after its first cycle", async () => {
    const path = await typoScenario();
    const db = await openMotebitDatabase(path);
    cleanups.push(() => db.close());
    const warned: string[] = [];
    const logged: string[] = [];
    const OK = { pulled: 0, pushed: 0, conflicts: [] } as unknown as SyncResult;
    const sync = {
      sync: () => Promise.resolve(OK),
      getLastError: () => null,
    } as unknown as SyncEngineType;
    const push = await cliEventPush.replStartupSync({
      runtime: { motebitId: MID, sync, connectSync: () => {} },
      syncUrl: RIGHT,
      motebitId: MID,
      log: (l) => logged.push(l),
      warn: (l) => warned.push(l),
      pushIntervalMs: 3_600_000,
      eventStore: db.eventStore,
    } as Parameters<typeof cliEventPush.replStartupSync>[0]);
    push.stop();
    const all = [...warned, ...logged].filter((l) => l.includes("motebit sync retire"));
    expect(all).toHaveLength(1);
    expect(all[0]).toContain(TYPO);
  });

  it("no notice when nothing is pinned", async () => {
    const path = dbPath();
    await withDb(path, async (db) => {
      await recordSyncIntent(db.eventStore, MID);
      await appendEvents(db, 5);
      await resolveSeqCursorStore(db.eventStore).setSyncSeqCursor(`push:raw:${RIGHT}#${MID}`, 5);
    });
    const { statusLines } = await syncModule();
    const lines = await statusLines({ dbPath: path, motebitId: MID, configuredUrl: RIGHT });
    expect(lines.some((l) => l.includes("motebit sync retire"))).toBe(false);
  });
});

describe("#962 round 6 C1 — motebit sync retire <relay-url>", () => {
  it("confirms, records an event, says what compaction frees — and compaction frees exactly that", async () => {
    const path = await typoScenario();
    const { runSyncCommand } = await syncModule();
    const { c, lines, asked } = ctx(path);
    expect(await runSyncCommand("retire", [TYPO], c)).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(TYPO);
    expect(lines.join("\n")).toMatch(/free[s]? 10 events/);
    const audit = await auditEvents(path);
    expect(audit.map((e) => (e.payload as { action?: string }).action)).toContain(
      "sync_stream_retired",
    );
    await withDb(path, async (db) => {
      const latest = await db.eventStore.getLatestClock(MID);
      const floor = await pushCompactionFloor(db.eventStore, latest - 1, { motebitId: MID });
      expect(floor).toBe(10);
      expect(await db.eventStore.compact!(MID, floor)).toBe(10);
    });
  });

  it("declined at the prompt: nothing changes", async () => {
    const path = await typoScenario();
    const { runSyncCommand } = await syncModule();
    const { c } = ctx(path, { confirm: () => Promise.resolve(false) });
    expect(await runSyncCommand("retire", [TYPO], c)).not.toBe(0);
    await withDb(path, async (db) => {
      expect(await pushCompactionFloor(db.eventStore, 19, { motebitId: MID })).toBe(0);
    });
    expect(await auditEvents(path)).toHaveLength(0);
  });

  it("refuses the currently configured relay unless --force", async () => {
    const path = await typoScenario();
    const { runSyncCommand } = await syncModule();
    const refused = ctx(path, { configuredUrl: TYPO });
    expect(await runSyncCommand("retire", [TYPO], refused.c)).not.toBe(0);
    expect(refused.asked).toHaveLength(0);
    expect(refused.lines.join("\n")).toMatch(/--force/);
    await withDb(path, async (db) => {
      expect(await pushCompactionFloor(db.eventStore, 19, { motebitId: MID })).toBe(0);
    });
    const forced = ctx(path, { configuredUrl: TYPO, force: true });
    expect(await runSyncCommand("retire", [TYPO], forced.c)).toBe(0);
    await withDb(path, async (db) => {
      expect(await pushCompactionFloor(db.eventStore, 19, { motebitId: MID })).toBe(10);
    });
  });

  it("an unknown relay is refused, naming the streams that exist", async () => {
    const path = await typoScenario();
    const { runSyncCommand } = await syncModule();
    const { c, lines } = ctx(path);
    expect(await runSyncCommand("retire", ["https://nope.example"], c)).not.toBe(0);
    expect(lines.join("\n")).toContain(TYPO);
  });
});

describe("#962 round 6 P3 — motebit sync clear-intent", () => {
  it("refuses while the configured relay has unacked events; --force clears it, confirmed and recorded", async () => {
    const path = await typoScenario();
    const { runSyncCommand } = await syncModule();
    const refused = ctx(path);
    expect(await runSyncCommand("clear-intent", [], refused.c)).not.toBe(0);
    expect(refused.lines.join("\n")).toMatch(/unacknowledged|unacked/);
    await withDb(path, async (db) =>
      expect(await readSyncIntent(db.eventStore, MID)).toBe("recorded"),
    );

    const forced = ctx(path, { force: true });
    expect(await runSyncCommand("clear-intent", [], forced.c)).toBe(0);
    expect(forced.asked).toHaveLength(1);
    await withDb(path, async (db) =>
      expect(await readSyncIntent(db.eventStore, MID)).toBe("cleared"),
    );
    const audit = await auditEvents(path);
    expect(audit.map((e) => (e.payload as { action?: string }).action)).toContain(
      "sync_intent_cleared",
    );
  });

  it("clears without --force once the configured relay acked everything", async () => {
    const path = dbPath();
    await withDb(path, async (db) => {
      await recordSyncIntent(db.eventStore, MID);
      await appendEvents(db, 5);
      await resolveSeqCursorStore(db.eventStore).setSyncSeqCursor(`push:raw:${RIGHT}#${MID}`, 5);
    });
    const { runSyncCommand } = await syncModule();
    const { c } = ctx(path);
    expect(await runSyncCommand("clear-intent", [], c)).toBe(0);
    await withDb(path, async (db) =>
      expect(await readSyncIntent(db.eventStore, MID)).toBe("cleared"),
    );
  });
});

// ── C2: relay text never reaches the terminal raw ───────────────────────────

/** The reviewer's probe: OSC title set, BEL, clear screen; 544 characters. */
const HOSTILE = "\x1b]0;PWNED\x07\x1b[2J" + "X".repeat(530);
// eslint-disable-next-line no-control-regex
const FORBIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/;

describe("#962 round 6 C2 — /sync prints relay text sanitized and capped", () => {
  it("getLastError() carrying the probe", async () => {
    const out: string[] = [];
    const capture = (...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    const runtime = {
      sync: {
        sync: () => Promise.resolve({ pulled: 0, pushed: 0, conflicts: [] }),
        getLastError: () => new Error(`sync push: push refused ${HOSTILE}`),
      },
    } as never;
    await handleSlashCommand("sync", "", runtime, parseCliArgs([]));
    const failed = out.find((l) => l.includes("sync failed") || l.includes("Sync failed"));
    expect(failed).toBeDefined();
    expect(FORBIDDEN.test(failed!), JSON.stringify(failed!.slice(0, 60))).toBe(false);
    expect(failed!.length).toBeLessThanOrEqual(260);
  });

  it("sync() itself rejecting with the probe", async () => {
    const out: string[] = [];
    const capture = (...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const runtime = {
      sync: {
        sync: () => Promise.reject(new Error(HOSTILE)),
        getLastError: () => null,
      },
    } as never;
    await handleSlashCommand("sync", "", runtime, parseCliArgs([]));
    for (const l of out) {
      expect(FORBIDDEN.test(l), JSON.stringify(l.slice(0, 60))).toBe(false);
      expect(l.length).toBeLessThanOrEqual(260);
    }
  });
});

describe("#962 round 6 C2 — static: every print of an error message in apps/cli is sanitized", () => {
  it("enumerates each console/log/warn/report call carrying an error message, and each goes through sanitizeRelayText", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = globSync("**/*.ts", { cwd: src }).filter((f) => !f.includes("__tests__"));
    const PRINT = new Set(["log", "error", "warn", "info", "report", "print"]);
    const SAFE = new Set(["sanitizeRelayText", "syncFailureLine"]);
    const MESSAGE_NAMES = new Set(["message", "msg", "errMsg"]);
    const examined: string[] = [];
    const offenders: string[] = [];
    for (const rel of files) {
      const path = join(src, rel);
      const sf = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const carriesMessage = (x: ts.Node): boolean =>
        (ts.isPropertyAccessExpression(x) && ["message", "statusText"].includes(x.name.text)) ||
        (ts.isIdentifier(x) &&
          MESSAGE_NAMES.has(x.text) &&
          !(ts.isPropertyAccessExpression(x.parent) && x.parent.name === x)) ||
        (ts.isCallExpression(x) &&
          ts.isPropertyAccessExpression(x.expression) &&
          x.expression.name.text === "getLastError") ||
        (ts.isCallExpression(x) &&
          ts.isIdentifier(x.expression) &&
          x.expression.text === "String" &&
          x.arguments[0] != null &&
          /^(err|e|error|cause)$/.test(x.arguments[0].getText()));
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const c = node.expression;
          const name = ts.isPropertyAccessExpression(c)
            ? c.name.text
            : ts.isIdentifier(c)
              ? c.text
              : "";
          if (PRINT.has(name)) {
            let carries = false;
            let unsafe = false;
            const walk = (x: ts.Node, safe: boolean): void => {
              if (
                ts.isCallExpression(x) &&
                ts.isIdentifier(x.expression) &&
                SAFE.has(x.expression.text)
              ) {
                safe = true;
              }
              if (carriesMessage(x)) {
                carries = true;
                if (!safe) unsafe = true;
              }
              ts.forEachChild(x, (y) => walk(y, safe));
            };
            for (const a of node.arguments) walk(a, false);
            if (carries) {
              const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              const where = `${relative(src, path)}:${line}`;
              examined.push(where);
              if (unsafe) offenders.push(`${where}: ${node.getText().slice(0, 100)}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    // Aperture: the scan's reach, stated (a narrow scan never goes red).
    console.info(
      `#962 print-path scan: ${files.length} files, ${examined.length} error-message prints examined`,
    );
    expect(files.length).toBeGreaterThan(50);
    expect(examined.length).toBeGreaterThan(90);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
