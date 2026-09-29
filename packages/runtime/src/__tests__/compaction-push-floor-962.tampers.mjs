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

const TAMPERS = [
  {
    // The law itself: compaction deletes up to the requested clock, ignoring
    // every relay stream's acked push cursor.
    file: join(pkg, "src", "motebit-runtime.ts"),
    text: "const floor = await pushCompactionFloor(this.localEventStore, requested);",
    replacement: "const floor = requested;",
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
    text: "for (const [key, store] of streams) {",
    replacement: "for (const [key, store] of [...streams].slice(0, 1)) {",
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
    out = spawnSync("npx", ["vitest", "run", testFile, "--reporter=verbose"], {
      cwd: pkg,
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
