/**
 * Identity-authority single-writer gate tampers (Inc 2 cold review, F3) —
 * each tamper adds an authority writer the gate must refuse; the gate
 * (`scripts/check-identity-authority-inventory.ts`) must go RED on it.
 *
 *   (a) a NEW exported raw writer inside identity-authority.ts, beside (not
 *       inside) writeAuthority / applyChange — the file is not the exemption,
 *       the writer's declarations are;
 *   (b) a REGISTERED writer outside the single writer (applySuccession's
 *       registry key move) that starts writing one more authority column —
 *       the registration is file + function + table + COLUMN SET + count.
 *
 * Each tamper: edit the source, regenerate the census (so the freshness part
 * passes and the single-writer part is what decides), run the gate, expect a
 * failure naming "NEW authority writer", then restore the source and the
 * census byte for byte. A tamper whose text is not found, or that the gate
 * lets through, fails this script.
 *
 *   npx tsx scripts/tampers/identity-authority-single-writer.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CENSUS = "docs/design/identity-authority-inventory.generated.md";
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

interface Tamper {
  name: string;
  file: string;
  find: string;
  replace: string;
}

const TAMPERS: Tamper[] = [
  {
    name: "(a) a new exported raw writer in identity-authority.ts, outside writeAuthority/applyChange",
    file: "services/relay/src/identity-authority.ts",
    find: "// ── The doors' one entry (Inc 2: optional header) ───────────────────────",
    replace: `export function tamperSetPayTo(db: DatabaseDriver, motebitId: string, addr: string): void {
  db.prepare("UPDATE relay_service_listings SET pay_to_address = ? WHERE motebit_id = ?").run(addr, motebitId);
}

// ── The doors' one entry (Inc 2: optional header) ───────────────────────`,
  },
  {
    name: "(b) a registered writer (applySuccession's registry move) writes one more authority column",
    file: "services/relay/src/succession-apply.ts",
    find: `"UPDATE agent_registry SET public_key = ? WHERE motebit_id = ? AND (public_key = ? OR COALESCE(public_key, '') = '')"`,
    replace: `"UPDATE agent_registry SET public_key = ?, sweep_threshold = NULL WHERE motebit_id = ? AND (public_key = ? OR COALESCE(public_key, '') = '')"`,
  },
];

function run(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(TSX, args, { cwd: ROOT, encoding: "utf-8" });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

let failures = 0;
const censusPath = path.join(ROOT, CENSUS);
const censusBefore = readFileSync(censusPath, "utf-8");
for (const t of TAMPERS) {
  const file = path.join(ROOT, t.file);
  const original = readFileSync(file, "utf-8");
  if (!original.includes(t.find)) {
    console.error(`✗ ${t.name}: tamper text not found in ${t.file}`);
    failures++;
    continue;
  }
  try {
    writeFileSync(file, original.replace(t.find, t.replace));
    const regen = run(["scripts/inventory-identity-authority.ts"]);
    if (regen.status !== 0) throw new Error(`census regeneration failed:\n${regen.out}`);
    const gate = run(["scripts/check-identity-authority-inventory.ts"]);
    if (gate.status !== 0 && /NEW authority writer/.test(gate.out)) {
      console.log(`✓ ${t.name}: the gate went red`);
    } else {
      console.error(
        `✗ ${t.name}: the gate did NOT refuse it (exit ${gate.status})\n${gate.out.slice(0, 600)}`,
      );
      failures++;
    }
  } finally {
    writeFileSync(file, original);
    writeFileSync(censusPath, censusBefore);
  }
}
console.log(
  `identity-authority-single-writer tampers: ${TAMPERS.length - failures}/${TAMPERS.length} red`,
);
process.exit(failures === 0 ? 0 : 1);
