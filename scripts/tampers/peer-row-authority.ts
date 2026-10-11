/**
 * Peer row authority tamper checks (relay-federation@1.5 §3.1) — each guard,
 * removed, must turn the harness red.
 *
 * Every entry is (text the fix added in services/relay/src/federation.ts,
 * what to put back, the vitest name filter that must go red). The runner
 * applies one tamper at a time, runs the harness
 * (`services/relay/src/__tests__/federation-peer-row-authority.test.ts`,
 * plus the key-pinning suite where named), expects a FAILURE, and restores
 * the file. An entry whose text is not found is a failure of this script.
 *
 *   npx tsx scripts/tampers/peer-row-authority.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE = "services/relay/src/federation.ts";
const PKG = "services/relay";
const HARNESS = "src/__tests__/federation-peer-row-authority.test.ts";
const PINNING = "src/__tests__/federation-peer-key-pinning.test.ts";

interface Tamper {
  name: string;
  find: string;
  replace: string;
  /** Test files that must go red (default: the harness). */
  tests?: string[];
  /** vitest `-t` filter (default: the whole file). */
  filter?: string;
}

const TAMPERS: Tamper[] = [
  {
    name: "compare-and-set: the key clause (d5baf1c54's upsert WHERE key clause, generalised)",
    find: "peer_relay_id = ? AND public_key = ? AND endpoint_url = ?",
    replace: "peer_relay_id = ? AND ? IS NOT NULL AND endpoint_url = ?",
    filter: "stale read",
  },
  {
    name: "compare-and-set: the endpoint clause",
    find: "AND public_key = ? AND endpoint_url = ? AND state = ?",
    replace: "AND public_key = ? AND ? IS NOT NULL AND state = ?",
    filter: "stale read",
  },
  {
    name: "compare-and-set: the state clause",
    find: "AND endpoint_url = ? AND state = ?\n",
    replace: "AND endpoint_url = ? AND ? IS NOT NULL\n",
    filter: "stale read",
  },
  {
    name: "guard: a public_key rewrite is refused",
    find: 'if (write.row.public_key !== before.public_key) return "a peer\'s public_key is never rewritten";',
    replace: "",
    filter: "peerRowTransition",
  },
  {
    name: "guard: a confirmed row is never deleted by a request",
    find: 'if (write.op === "delete") return "a confirmed peer\'s row is deleted only by its operator";',
    replace: "",
    filter: "peerRowTransition",
  },
  {
    name: "guard: an unauthenticated request never writes a confirmed row",
    find: 'return "an unauthenticated request never writes a confirmed peer\'s row";',
    replace: "return null;",
  },
  {
    name: "guard: an observation never moves the endpoint",
    find: 'return "the endpoint moves only under the peer\'s key";',
    replace: "return null;",
    filter: "peerRowTransition",
  },
  {
    name: "guard: an observation never moves toward active",
    find: 'return "a move to active or pending needs the peer\'s key";',
    replace: "return null;",
    filter: "peerRowTransition",
  },
  {
    name: "propose: a confirmed peer re-handshakes beside its row, not in it",
    find: "    if (existing?.peered_at != null) {\n      // A confirmed peer re-handshakes",
    replace: "    if (false as boolean) {\n      // A confirmed peer re-handshakes",
    filter: "initial suspended",
  },
  {
    name: "propose: the key on record is compared before anything is signed",
    find: "if (existing && existing.public_key.toLowerCase() !== public_key.toLowerCase()) {",
    replace: "if (false as boolean) {",
    tests: [PINNING],
  },
  {
    name: "propose: a confirmed peer's re-handshake spends no per-peer slot",
    find: "if (existing?.peered_at == null) checkPeerLimit(relay_id);",
    replace: "checkPeerLimit(relay_id);",
    filter: "flood",
  },
  {
    name: "confirm: a confirmed peer's failed confirm spends no per-peer slot",
    find: "if (!confirmed) checkPeerLimit(relay_id);",
    replace: "checkPeerLimit(relay_id);",
    filter: "flood",
  },
];

function passes(test: string, filter: string | undefined): boolean {
  try {
    execFileSync("npx", ["vitest", "run", test, ...(filter ? ["-t", filter] : [])], {
      cwd: path.join(ROOT, PKG),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const abs = path.join(ROOT, FILE);
const original = readFileSync(abs, "utf8");
let failures = 0;
for (const t of TAMPERS) {
  if (!original.includes(t.find)) {
    console.error(`STALE  ${t.name}: text not found in ${FILE}`);
    failures++;
    continue;
  }
  writeFileSync(abs, original.replace(t.find, t.replace));
  try {
    const tests = t.tests ?? [HARNESS];
    const green = tests.filter((f) => passes(f, t.filter));
    if (green.length === tests.length) {
      console.error(`GREEN  ${t.name}: ${tests.join(", ")} still passes with the guard removed`);
      failures++;
    } else {
      console.log(`red    ${t.name}`);
    }
  } finally {
    writeFileSync(abs, original);
  }
}
if (failures > 0) {
  console.error(`${failures} tamper(s) did not turn the harness red`);
  process.exit(1);
}
console.log(`all ${TAMPERS.length} tampers turned the harness red`);
