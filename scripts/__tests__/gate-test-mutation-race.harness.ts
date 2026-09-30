/**
 * Harness for the gate-self-test mutation race (`repo-file-mutation.ts`).
 * NOT a vitest file — it is minutes of wall clock by design:
 *
 *   npx tsx scripts/__tests__/gate-test-mutation-race.harness.ts [runs=4] [timeoutMs]
 *
 * Runs the self-tests that perturb real repo files — check-deps and
 * check-spec-routes — as `runs` concurrent vitest processes (the overlap a
 * pre-push `test:gates` meets beside another lane's run), then requires:
 * every run green, no `ENOENT` on a backup, no backup file left in the tree,
 * and every perturbed file byte-identical to its committed content.
 *
 * The per-test budget is the REAL one — read from the root `test:gates`
 * script, not chosen here. The harness used to run at 900 s, which hid that
 * a test waiting its turn for the lock outlived the 30 s `test:gates` gives
 * it: 4 concurrent runs at 30 s were 3/4 red on 48f1547. A lock wait that
 * only fits a budget nobody runs with is not a fix.
 *
 * Before the lock + out-of-tree backups: 10/10 runs red (ENOENT on
 * `identity-transparency.ts.gate-test-backup` / `package.json.deps-test-backup`,
 * backup-guard collisions, gate output from another run's fixture), and the
 * repo left corrupted (an emptied `identity-transparency.ts`, a mutated
 * `packages/verifier/package.json`).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNS = Number(process.argv[2] ?? "4");
const TEST_GATES = (
  JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts["test:gates"]!;
const TIMEOUT = Number(process.argv[3] ?? /--testTimeout=(\d+)/.exec(TEST_GATES)?.[1] ?? NaN);
if (!Number.isFinite(TIMEOUT)) throw new Error(`no --testTimeout in test:gates: ${TEST_GATES}`);
const FILES = [
  "scripts/__tests__/check-deps.test.ts",
  "scripts/__tests__/check-spec-routes.test.ts",
];
const PERTURBED = [
  "services/relay/src/identity-transparency.ts",
  "packages/verifier/package.json",
  "apps/cli/package.json",
];
const LEGACY_BACKUPS = [
  "services/relay/src/identity-transparency.ts.gate-test-backup",
  "packages/verifier/package.json.deps-test-backup",
  "apps/cli/package.json.deps-test-backup",
];

const before = new Map(PERTURBED.map((p) => [p, readFileSync(resolve(ROOT, p), "utf8")]));

function runOnce(i: number): Promise<{ i: number; code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(
      "npx",
      [
        "vitest",
        "run",
        "--dir",
        "scripts/__tests__",
        `--testTimeout=${TIMEOUT}`,
        `--hookTimeout=${TIMEOUT}`,
        ...FILES,
      ],
      { cwd: ROOT, env: { ...process.env, CI: "1" } },
    );
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => done({ i, code, output }));
  });
}

async function main(): Promise<void> {
  const results = await Promise.all(Array.from({ length: RUNS }, (_, i) => runOnce(i)));
  const failures: string[] = [];
  for (const r of results) {
    if (r.code !== 0) {
      const why = r.output
        .split("\n")
        .filter((l) => /ENOENT|AssertionError|Error:|timed out/.test(l))
        .slice(0, 3)
        .join(" | ");
      failures.push(`run ${r.i}: exit ${r.code} — ${why}`);
    }
  }
  for (const [p, content] of before) {
    if (readFileSync(resolve(ROOT, p), "utf8") !== content) failures.push(`${p} was left modified`);
  }
  for (const b of LEGACY_BACKUPS) {
    if (existsSync(resolve(ROOT, b))) failures.push(`backup left in the tree: ${b}`);
  }

  if (failures.length > 0) {
    console.error(
      `gate-test-mutation-race: ${failures.length} failure(s) over ${RUNS} concurrent runs at --testTimeout=${TIMEOUT}`,
    );
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "  restore with: git checkout -- " +
        PERTURBED.join(" ") +
        "  (then see scripts/__tests__/repo-file-mutation.ts)",
    );
    process.exit(1);
  }
  console.log(
    `gate-test-mutation-race: ${RUNS}/${RUNS} concurrent runs of ${FILES.length} perturbing self-tests green ` +
      `at --testTimeout=${TIMEOUT}; ` +
      `${PERTURBED.length} perturbed files byte-identical; no backup in the tree.`,
  );
}

void main();
