/**
 * Mutation check for the turbo test-cache defenses.
 *
 * Applies each single-line mutation in scripts/turbo-cache-mutations.json ALONE,
 * runs the test file(s) it names, and requires them to go RED; then restores
 * the file. A mutation that survives is a claim no test pins. A baseline run
 * first proves every named test file is green unmutated.
 *
 * Usage: tsx scripts/turbo-cache-mutations.ts [ID…]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Mutation {
  id: string;
  claim: string;
  file: string;
  find: string;
  replace: string;
  tests: string[];
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { mutations } = JSON.parse(
  readFileSync(join(ROOT, "scripts", "turbo-cache-mutations.json"), "utf-8"),
) as { mutations: Mutation[] };

function runTests(tests: string[]): { ok: boolean; out: string } {
  const r = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "--dir",
      "scripts/__tests__",
      ...tests,
      "--testTimeout=180000",
      "--hookTimeout=180000",
    ],
    { cwd: ROOT, encoding: "utf-8" },
  );
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

const only = process.argv.slice(2);
const selected = only.length ? mutations.filter((m) => only.includes(m.id)) : mutations;
const files = [...new Set(selected.flatMap((m) => m.tests))];
const base = runTests(files);
if (!base.ok) {
  console.error(`baseline is not green for ${files.join(", ")}:\n${base.out.slice(-3000)}`);
  process.exit(2);
}
console.log(`baseline green: ${files.join(", ")}`);

let killed = 0;
const survivors: string[] = [];
for (const m of selected) {
  const path = join(ROOT, m.file);
  const orig = readFileSync(path, "utf-8");
  const n = orig.split(m.find).length - 1;
  if (n !== 1) {
    console.log(`INVALID  ${m.id} ${m.claim} — the find text matches ${n} time(s) in ${m.file}`);
    survivors.push(m.id);
    continue;
  }
  const t0 = Date.now();
  writeFileSync(path, orig.replace(m.find, m.replace));
  let r: { ok: boolean; out: string };
  try {
    r = runTests(m.tests);
  } finally {
    writeFileSync(path, orig);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!r.ok) {
    killed++;
    const failed = (r.out.match(/Tests\s+(\d+) failed/) ?? [])[1] ?? "?";
    console.log(`KILLED   ${m.id} ${secs.padStart(5)}s  ${failed} test(s) red — ${m.claim}`);
  } else {
    survivors.push(m.id);
    console.log(`SURVIVED ${m.id} ${secs.padStart(5)}s  — ${m.claim}`);
  }
}
console.log(`\n${killed}/${selected.length} mutation(s) turned a test red.`);
if (survivors.length) {
  console.log(`survivors: ${survivors.join(", ")}`);
  process.exit(1);
}
