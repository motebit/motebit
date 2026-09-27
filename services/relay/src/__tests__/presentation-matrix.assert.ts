/**
 * The per-cell verdict for `presentation-matrix.probe.ts` (#811 v4): branch
 * against main, cell by cell. Not a vitest file — run it with tsx:
 *
 *   pnpm tsx services/relay/src/__tests__/presentation-matrix.assert.ts <report.json>
 *   pnpm tsx services/relay/src/__tests__/presentation-matrix.assert.ts --base a.json --head b.json
 *
 * `<report.json>` is the `--out` of scripts/differential-vs-main.ts (its
 * `baseObs` and `head`); `--base/--head` take two raw PROBE_OUT files (a
 * variant run against a saved main run). Prints the full table and exits 1
 * on any red cell. A cell is red when:
 *   A1  executions(branch) > executions(main), where main executed at least
 *       once (a cell main never executed is A3's);
 *   A2  main completed and the branch did not, or main settled (≥ 1
 *       settlement row) and the branch did not;
 *   A3  main executed 0 times and the branch more than once;
 *   or either side errored, or the cell is missing on one side.
 * The run is refused (exit 1) unless both sides observed executions in at
 * least one cell — a side that observed nothing proves nothing (#851).
 */
import { readFileSync } from "node:fs";

interface CellObs {
  e?: number;
  done?: boolean;
  s?: number;
  st?: string | null;
  p?: number;
  ex?: Record<string, number>;
  error?: string;
  tok?: boolean;
}

function load(): { base: Record<string, CellObs>; head: Record<string, CellObs> } {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--base");
  const hi = args.indexOf("--head");
  if (bi >= 0 && hi >= 0) {
    return {
      base: JSON.parse(readFileSync(args[bi + 1]!, "utf8")) as Record<string, CellObs>,
      head: JSON.parse(readFileSync(args[hi + 1]!, "utf8")) as Record<string, CellObs>,
    };
  }
  if (args[0] == null) throw new Error("usage: <report.json> | --base <a.json> --head <b.json>");
  const report = JSON.parse(readFileSync(args[0], "utf8")) as {
    baseObs?: Record<string, CellObs>;
    head?: Record<string, CellObs>;
  };
  if (report.baseObs == null || report.head == null)
    throw new Error("the report has no baseObs/head observations");
  return { base: report.baseObs, head: report.head };
}

function fmt(o: CellObs | undefined): string {
  if (o == null) return "MISSING";
  if (o.error != null) return `ERROR(${o.error.slice(0, 40)})`;
  const paths = Object.entries(o.ex ?? {})
    .map(([k, v]) => `${k}${v}`)
    .join("+");
  return `e=${o.e ?? "?"}${paths ? `(${paths})` : ""} ${o.done ? "done" : "open"} s=${o.s ?? "?"} p=${o.p ?? "?"}${o.tok ? " tok" : ""}`;
}

function verdict(b: CellObs | undefined, h: CellObs | undefined): string[] {
  if (b == null || h == null) return ["missing"];
  if (b.error != null || h.error != null) return ["error"];
  const red: string[] = [];
  const be = b.e ?? 0;
  const he = h.e ?? 0;
  if (be > 0 && he > be) red.push("A1");
  if ((b.done === true && h.done !== true) || ((b.s ?? 0) > 0 && (h.s ?? 0) <= 0)) red.push("A2");
  if (be === 0 && he > 1) red.push("A3");
  return red;
}

const { base, head } = load();
const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])]
  .filter((k) => !k.startsWith("_"))
  .sort();
let red = 0;
let diff = 0;
const byMode = new Map<string, { cells: number; red: number; diff: number }>();
console.log("cell | main | branch | verdict");
for (const k of keys) {
  const b = base[k];
  const h = head[k];
  const v = verdict(b, h);
  const same = fmt(b) === fmt(h);
  if (v.length > 0) red++;
  if (!same) diff++;
  const mode = k.split("|")[0]!;
  const m = byMode.get(mode) ?? { cells: 0, red: 0, diff: 0 };
  m.cells++;
  if (v.length > 0) m.red++;
  if (!same) m.diff++;
  byMode.set(mode, m);
  console.log(
    `${k} | ${fmt(b)} | ${fmt(h)} | ${v.length > 0 ? `RED ${v.join(",")}` : same ? "same" : "ok-diff"}`,
  );
}
const executed = (o: Record<string, CellObs>) =>
  Object.entries(o).filter(([k, v]) => !k.startsWith("_") && (v.e ?? 0) > 0).length;
console.log("");
for (const [mode, m] of byMode)
  console.log(`${mode}: ${m.cells} cells, ${m.diff} differ, ${m.red} red`);
console.log(
  `\n${keys.length} cells; ${diff} differ from main; ${red} red. Cells with ≥1 execution: main ${executed(base)}, branch ${executed(head)}.`,
);
if (executed(base) === 0 || executed(head) === 0) {
  console.log("REFUSED: a side observed no executions at all — nothing was proven (#851).");
  process.exit(1);
}
process.exit(red > 0 ? 1 : 0);
