/**
 * How `pnpm check` and `check-gates-effective` launch a gate: as
 * `tsx <script file> [-- <args>]`, resolved from the gate's root package.json
 * script, instead of `pnpm --silent run <script> [-- <args>]` (whose
 * pnpm → npx → tsx chain cost ~1.15s of launch per gate, measured 2026-10-07).
 *
 * The resolution fails closed: a gate whose script is anything other than
 * exactly `npx tsx <scripts/… .ts>` naming a file that exists is refused, so
 * a gate can never silently run something other than what `pnpm run` would.
 * Args keep pnpm's argv shape (`pnpm run x -- --strict` hands the script
 * `["--", "--strict"]`; `tsx file -- --strict` does the same).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The one script shape a gate may have: `npx tsx scripts/<path>.ts`. */
const GATE_SCRIPT = /^npx tsx (scripts\/[A-Za-z0-9_./-]+\.ts)$/;

/**
 * The script file (repo-relative) for each named root package.json script.
 * Throws, naming every gate that cannot be resolved, when any one cannot.
 */
export function resolveGateFiles(root: string, scripts: readonly string[]): Map<string, string> {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")) as {
    scripts?: Record<string, string>;
  };
  const out = new Map<string, string>();
  const unresolved: string[] = [];
  for (const name of new Set(scripts)) {
    const body = pkg.scripts?.[name];
    const m = body == null ? null : GATE_SCRIPT.exec(body);
    const file = m?.[1];
    if (file == null || file.split("/").includes("..") || !existsSync(resolve(root, file))) {
      unresolved.push(
        `  - ${name}: ${body == null ? "no such root package.json script" : JSON.stringify(body)}`,
      );
      continue;
    }
    out.set(name, file);
  }
  if (unresolved.length > 0) {
    throw new Error(
      `cannot launch ${unresolved.length} gate(s) directly — each gate's root package.json script ` +
        `must be exactly \`npx tsx scripts/<file>.ts\` naming an existing file:\n${unresolved.join("\n")}\n` +
        `Fix the script (put flags in the gate's \`args\`, not the script), see scripts/lib/gate-launch.ts.`,
    );
  }
  return out;
}

/** The argv after the tsx binary: the file, then pnpm's `--` + args shape. */
export function gateArgv(file: string, args: readonly string[] | undefined): string[] {
  return args && args.length > 0 ? [file, "--", ...args] : [file];
}

/** Committed per-gate wall-time hint (ms) — only orders the pool, never judges. */
export const TIMING_HINT_FILE = "scripts/gate-timing-hint.json";

export function readTimingHint(root: string): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(resolve(root, TIMING_HINT_FILE), "utf-8")) as unknown;
    if (raw == null || typeof raw !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Indices of `names` in launch order: gates with no hint first (their cost is
 * unknown, so start them early), then longest hint first; ties keep input order.
 */
export function longestFirst(names: readonly string[], hint: Record<string, number>): number[] {
  const rank = (n: string): number => (Object.hasOwn(hint, n) ? hint[n]! : Infinity);
  return names.map((_, i) => i).sort((a, b) => rank(names[b]!) - rank(names[a]!) || a - b);
}
