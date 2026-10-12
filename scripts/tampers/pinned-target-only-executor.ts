/**
 * Pinned-target tamper checks — each enforcement point, removed, must turn
 * its test red (task-pin.ts: a task submitted for an explicit target is
 * executed by that target or by no one).
 *
 * Every entry is (file, text the fix added, what to put back, the test that
 * must go red). One tamper at a time: apply, run the named test, expect a
 * FAILURE, restore. An entry whose text is not found is a failure of this
 * script (a stale tamper would otherwise pass silently).
 *
 *   npx tsx scripts/tampers/pinned-target-only-executor.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = "services/relay";
const ROUTES = "src/__tests__/pinned-target-only-executor.test.ts";
const DOORS = "src/__tests__/pinned-target-doors.test.ts";

interface Edit {
  file: string;
  find: string;
  replace: string;
}
interface Tamper {
  name: string;
  edits: Edit[];
  test: string;
  /** `-t` filter: the cell that must go red. */
  filter: string;
}

const TAMPERS: Tamper[] = [
  {
    name: "fallback selector (Phase 3): main's capability query, pin filter off",
    edits: [
      {
        file: "services/relay/src/tasks.ts",
        find: "        pin == null\n          ? moteDb.db",
        replace: "        (true as boolean)\n          ? moteDb.db",
      },
      {
        file: "services/relay/src/tasks.ts",
        find: "      const httpCandidate = candidatesUnderPin(\n        pin,",
        replace: "      const httpCandidate = candidatesUnderPin(\n        null,",
      },
    ],
    test: ROUTES,
    filter: "HTTP MCP decoy",
  },
  {
    name: "scored selection (Phase 1): ranking instead of the pin, candidate filter off",
    edits: [
      {
        file: "services/relay/src/tasks.ts",
        find: "            pin != null\n              ? pinnedSelection(pin, allProfiles)",
        replace:
          "            (false as boolean)\n              ? pinnedSelection(pin!, allProfiles)",
      },
      {
        file: "services/relay/src/tasks.ts",
        find: "        const eligibleProfiles = candidatesUnderPin(\n          pin,",
        replace: "        const eligibleProfiles = candidatesUnderPin(\n          null,",
      },
      {
        file: "services/relay/src/tasks.ts",
        find: "        const federatedProfiles = candidatesUnderPin(\n          pin,",
        replace: "        const federatedProfiles = candidatesUnderPin(\n          null,",
      },
    ],
    test: ROUTES,
    filter: "WebSocket decoy",
  },
  {
    name: "scored selection (Phase 1), federated: a peer relay's decoy",
    edits: [
      {
        file: "services/relay/src/tasks.ts",
        find: "            pin != null\n              ? pinnedSelection(pin, allProfiles)",
        replace:
          "            (false as boolean)\n              ? pinnedSelection(pin!, allProfiles)",
      },
      {
        file: "services/relay/src/tasks.ts",
        find: "        const federatedProfiles = candidatesUnderPin(\n          pin,",
        replace: "        const federatedProfiles = candidatesUnderPin(\n          null,",
      },
    ],
    test: ROUTES,
    filter: "federated decoy",
  },
  {
    name: "claim check: a non-target body is granted the pinned task",
    edits: [
      {
        file: "services/relay/src/task-claim.ts",
        find: "    if (pinRefusesClaim(entry, motebitId)) {",
        replace: "    if (false as boolean) {",
      },
    ],
    test: ROUTES,
    filter: "neither presented nor granted",
  },
  {
    name: "reconnect recovery: a pinned task presented to a non-target's body",
    edits: [
      {
        file: "services/relay/src/websocket.ts",
        find: "            !pinRefusesClaim(entry, motebitId) &&\n",
        replace: "",
      },
    ],
    test: ROUTES,
    filter: "neither presented nor granted",
  },
  {
    name: "released forward: re-presented to the path agent's bodies",
    edits: [
      {
        file: "services/relay/src/tasks.ts",
        find: "released != null && !pinRefusesClaim(released, released.task.motebit_id)",
        replace: "released != null",
      },
    ],
    test: ROUTES,
    filter: "released forward",
  },
  {
    name: "result acceptance: a substitute's receipt becomes the answer",
    edits: [
      {
        file: "services/relay/src/task-answer.ts",
        find: "  if (pinRefusesAnswer(entry, receipt.motebit_id)) {",
        replace: "  if (false as boolean) {",
      },
    ],
    test: ROUTES,
    filter: "free pinned task",
  },
  {
    name: "settlement attribution: a substitute is paid (answer door bypassed)",
    edits: [
      {
        file: "services/relay/src/task-answer.ts",
        find: "  if (pinRefusesSettlement(entry, answer.motebit_id)) {",
        replace: "  if (false as boolean) {",
      },
    ],
    test: DOORS,
    filter: "never settled",
  },
  {
    name: "admission: the pin is never stamped on the entry",
    edits: [
      {
        file: "services/relay/src/tasks.ts",
        find: "        ...(pin != null ? { pinned_executor: pin } : {}),\n",
        replace: "",
      },
    ],
    test: ROUTES,
    filter: "neither presented nor granted",
  },
];

function run(args: string[]): boolean {
  try {
    execFileSync("npx", args, { cwd: path.join(ROOT, PKG), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
for (const t of TAMPERS) {
  const originals = new Map<string, string>();
  let stale: string | null = null;
  for (const e of t.edits) {
    const abs = path.join(ROOT, e.file);
    if (!originals.has(abs)) originals.set(abs, readFileSync(abs, "utf8"));
  }
  const current = new Map(originals);
  for (const e of t.edits) {
    const abs = path.join(ROOT, e.file);
    const text = current.get(abs)!;
    if (!text.includes(e.find)) {
      stale = e.file;
      break;
    }
    current.set(abs, text.replace(e.find, e.replace));
  }
  if (stale != null) {
    console.error(`STALE  ${t.name}: text not found in ${stale}`);
    failures++;
    continue;
  }
  for (const [abs, text] of current) writeFileSync(abs, text);
  try {
    if (run(["vitest", "run", t.test, "-t", t.filter])) {
      console.error(`GREEN  ${t.name}: ${t.test} [${t.filter}] still passes with the fix removed`);
      failures++;
    } else {
      console.log(`red    ${t.name}`);
    }
  } finally {
    for (const [abs, text] of originals) writeFileSync(abs, text);
  }
}
if (failures > 0) {
  console.error(`${failures} tamper(s) did not turn their test red`);
  process.exit(1);
}
console.log(`all ${TAMPERS.length} tampers turned their test red`);
