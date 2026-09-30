#!/usr/bin/env node
// Tamper check for compaction-push-floor-962.test.ts (#962).
//
// Each entry reverts one clause of the fix and names the test expected to go
// red. The script applies the tamper, rebuilds the tampered package when it
// is not the runtime (the runtime's tests import workspace packages from
// dist), runs the file, restores the source, rebuilds, and fails if a tamper
// did not apply (a false green) or the named test stayed green.
//
//   node packages/runtime/src/__tests__/compaction-push-floor-962.tampers.mjs
//
// Run from anywhere; paths resolve relative to this file.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const root = join(pkg, "..", "..");
const testFile = join(here, "compaction-push-floor-962.test.ts");
const desktop = join(root, "apps", "desktop");
const mobile = join(root, "apps", "mobile");
const desktopTest = join(desktop, "src", "__tests__", "tauri-storage.test.ts");
const mobileTest = join(mobile, "src", "__tests__", "expo-sqlite-sync-cursor.test.ts");

const TAMPERS = [
  {
    // The law itself: compaction deletes up to the requested clock, ignoring
    // every relay stream's acked push cursor.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "const floor = await pushCompactionFloor(this.localEventStore, requested, {",
    replacement: "const floor = requested;\n    void this.localEventStore;\n    void ({",
    red: "never pushed: an appended event survives compaction",
  },
  {
    // Fail closed: an unreadable cursor compacts as if no relay existed.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "  } catch {\n    return 0;\n  }\n}",
    replacement: "  } catch {\n    return requested;\n  }\n}",
    red: "sync configured but the cursor unreadable",
  },
  {
    // The minimum across relay streams: only the first stream is read.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "return Math.min(requested, ...acked.values());",
    replacement: "return Math.min(requested, [...acked.values()][0]!);",
    red: "two relay streams: the floor is the minimum across them",
  },
  {
    // Enrollment persisted at connect: a later process, before it connects
    // sync, would not know a relay stream exists.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "if ((await cursors.getSyncSeqCursor(key)) === null) await cursors.setSyncSeqCursor(key, 0);",
    replacement: "void cursors;",
    red: "a later process, before it connects sync",
  },
  {
    // The SQLite store lists its push cursors.
    file: join(root, "packages", "persistence", "src", "index.ts"),
    build: "@motebit/persistence",
    text: "return rows.map((r) => r.cursor_key);",
    replacement: "return rows.length < 0 ? [] : [];",
    red: "sqlite store > a later process, before it connects sync",
  },
  {
    // The IndexedDB store lists its push cursors.
    file: join(root, "packages", "browser-persistence", "src", "event-store.ts"),
    build: "@motebit/browser-persistence",
    text: 'return keys.filter((k): k is string => typeof k === "string" && k.startsWith(prefix));',
    replacement: "return keys.length < 0 ? [prefix] : [];",
    red: "idb store > a later process, before it connects sync",
  },
  {
    // #962 round 2 F1: one relay, many cursors — group keys by relay stream.
    // Keyed per cursor key, mobile's stale /sync cursor pins the live one.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "const stream = relayStreamOfPushKey(key);",
    replacement: "const stream = key;",
    red: "sqlite store > F1 mobile: a /sync cursor and the live cursor",
  },
  {
    // F1: the MAX within a stream — the MIN there pins the CLI's raw cursor
    // at the stale E2E one.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "acked.set(stream, Math.max(acked.get(stream) ?? 0, cursor));",
    replacement: "acked.set(stream, Math.min(acked.get(stream) ?? cursor, cursor));",
    red: "idb store > F1 CLI: a raw cursor beside an E2E cursor",
  },
  {
    // F2 / P-a: configured with no stream cursor compacts nothing.
    file: join(root, "packages", "sync-engine", "src", "index.ts"),
    build: "@motebit/sync-engine",
    text: "if (acked.size === 0) return options.syncConfigured === true ? 0 : requested;",
    replacement: "if (acked.size === 0) return options.syncConfigured === true ? requested : requested;",
    red: "sqlite store > F2: the enrollment write lost",
  },
  {
    // F2: the runtime passes the host's signal to the floor.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "syncConfigured: await this.resolveSyncConfigured(),",
    replacement: "syncConfigured: undefined,",
    red: "idb store > P-a: a relay configured but never connected",
  },
  {
    // F2: a provider that cannot tell fails closed.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "      return (await c()) !== false;\n    } catch {\n      return true;",
    replacement: "      return (await c()) !== false;\n    } catch {\n      return false;",
    red: "sqlite store > P-a: a provider that cannot tell (throws) fails closed",
  },
  {
    // F3: the Tauri store lists its push cursors (SQL over real SQLite).
    file: join(desktop, "src", "tauri-storage.ts"),
    testFile: desktopTest,
    cwd: desktop,
    text: '"SELECT cursor_key FROM sync_seq_cursors WHERE substr(cursor_key, 1, length(?)) = ?",\n      [prefix, prefix],\n    );\n    return rows.map((r) => r.cursor_key);\n  }\n\n  async setSyncSeqCursor',
    replacement: '"SELECT cursor_key FROM sync_seq_cursors WHERE 0 AND substr(cursor_key, 1, length(?)) = ?",\n      [prefix, prefix],\n    );\n    return rows.map((r) => r.cursor_key);\n  }\n\n  async setSyncSeqCursor',
    red: "lists exactly its push: cursor keys, and the #962 floor reads them",
  },
  {
    // F3: the Expo store lists its push cursors (SQL over real SQLite).
    file: join(mobile, "src", "adapters", "expo-sqlite.ts"),
    testFile: mobileTest,
    cwd: mobile,
    text: '"SELECT cursor_key FROM sync_seq_cursors WHERE substr(cursor_key, 1, length(?)) = ?",',
    replacement: '"SELECT cursor_key FROM sync_seq_cursors WHERE 0 AND substr(cursor_key, 1, length(?)) = ?",',
    red: "lists exactly its push: cursor keys, and the #962 floor reads them",
  },
];

function build(name) {
  if (!name) return;
  const out = spawnSync("pnpm", ["--filter", name, "build"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`build ${name} failed:\n${out.stdout}\n${out.stderr}`);
}

let failed = false;
for (const t of TAMPERS) {
  const original = readFileSync(t.file, "utf8");
  if (!original.includes(t.text)) {
    console.error(`TAMPER DID NOT APPLY (re-target it): ${t.file}: ${JSON.stringify(t.text)}`);
    failed = true;
    continue;
  }
  writeFileSync(t.file, original.replace(t.text, t.replacement));
  let out;
  try {
    build(t.build);
    out = spawnSync("npx", ["vitest", "run", t.testFile ?? testFile, "--reporter=verbose"], {
      cwd: t.cwd ?? pkg,
      encoding: "utf8",
    });
  } finally {
    writeFileSync(t.file, original);
    build(t.build);
  }
  const log = `${out.stdout}\n${out.stderr}`;
  const [scope, name] = t.red.includes(" > ") ? t.red.split(" > ") : [null, t.red];
  const redLine = log
    .split("\n")
    .find((l) => l.includes("×") && l.includes(name) && (scope === null || l.includes(scope)));
  if (out.status !== 0 && redLine) {
    console.log(`red as expected: ${t.red}`);
  } else {
    console.error(`STAYED GREEN with the fix removed: ${t.red}\n${log.slice(-4000)}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
