/**
 * CLI-surface drift gate — locks the operator-ergonomic contract of the
 * `motebit` reference runtime to a committed baseline.
 *
 * Scope is deliberately narrow: **operator muscle memory**. The things a
 * user types, the flags they append, the exit codes their shell scripts
 * branch on, the paths their `~/.motebit` scripts pin to. If a human
 * sitting at a terminal would notice a change, it belongs here.
 *
 * The Apache-2.0 protocol packages have `check-api-surface` to
 * mechanically enforce the .d.ts side of their 1.0. Until 2026-04-24
 * the CLI's operator-ergonomic promise rested on changeset discipline
 * alone — same `1.0` word, different rigor. This gate closes that
 * asymmetry.
 *
 * Four sub-surfaces, all operator-ergonomic:
 *
 *   1. Subcommand tree — top-level subcommands and their sub-subcommands,
 *      extracted from `apps/cli/src/index.ts` dispatcher (every
 *      `if (subcommand === "X")` line, plus the four known
 *      sub-subcommand families: approvals, federation, relay, goal,
 *      and the verify→identity special case).
 *
 *   2. Top-level flag set — name, type, default, short alias — extracted
 *      from `apps/cli/src/args.ts` parseArgs `options:` object.
 *
 *   3. Exit codes — the sorted set of unique `process.exit(N)` values
 *      used anywhere under `apps/cli/src/`. Shell scripts wrapping
 *      motebit invocations branch on exit codes; {0, 1, 2, 130} is the
 *      current contract. A new non-zero code is additive but should be
 *      declared; removing 130 would break scripts that check SIGINT.
 *
 *   4. On-disk layout — the `~/.motebit/` paths referenced in the CLI
 *      source (config, database, identity, relay subdirectory, relay
 *      database). Operators pin scripts against these paths; renaming
 *      `config.json` or moving `relay.db` out of `~/.motebit/relay/`
 *      breaks their integrations. Transient files prefixed with `.` are
 *      intentionally excluded — they're implementation detail.
 *
 * Explicitly out of scope (tried in 2026-04-24's route + MCP-tool
 * extractors, removed the same day after a senior review pulled the
 * thread): relay HTTP routes and MCP server tool list. Those are
 * implementations of protocol-level promises in `spec/*.md`, not
 * operator-ergonomic contracts — and the right invariant for them is
 * "spec declares X, implementation serves X," not "implementation
 * today matches implementation yesterday." A spec-driven coverage
 * gate is the architecturally-native home for route and tool drift.
 * Tracked as a separate follow-up so this gate stays on a single
 * architectural axis.
 *
 * Strategy:
 *   - Extract the current surface from source.
 *   - Compare to the committed baseline at `apps/cli/etc/cli-surface.json`.
 *   - Fail on ANY drift. The baseline is a lockfile of the surface: it is
 *     refreshed (`pnpm check-cli-surface --write`) in the same PR as the
 *     surface change, never deferred to "before publishing".
 *   - The baseline carries `motebitMajor` — the `motebit` major whose
 *     contract the committed surface is. `--write` stamps it: a BREAKING
 *     diff against the previous baseline (anything removed or changed)
 *     stamps `current major + 1`; an additive diff keeps the stamp
 *     (adding a subcommand or flag is a minor under semver).
 *   - A stamp ahead of the package's current major is accepted only while a
 *     pending `.changeset/*.md` declares `motebit: major`. After
 *     `changeset version` consumes that changeset the package major has
 *     caught up with the stamp, so the gate stays green on the release
 *     commit with no further action.
 *
 * Why not "pending major excuses drift" (the pre-2026-10 rule): that rule
 * accepted an UNWRITTEN baseline for as long as any `motebit: major`
 * changeset was pending, and `changeset version` deletes the changeset —
 * so the Version Packages PR, the one commit that must be green, was the
 * commit that went red (#739: four additive drifts absorbed by an
 * unrelated major). The excuse depended on state the release consumes;
 * the stamp depends only on the baseline and the package version, which
 * the release moves together.
 *
 * Companion: check-api-surface.ts is the protocol-floor analogue. Together
 * they enforce: every `motebit@X.0` consumer has a mechanical guarantee
 * that the surface they pinned won't move silently between minor versions.
 *
 * This is the forty-sixth synchronization invariant defense.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const INDEX_PATH = resolve(ROOT, "apps/cli/src/index.ts");
const ARGS_PATH = resolve(ROOT, "apps/cli/src/args.ts");
const APPS_CLI_SRC = resolve(ROOT, "apps/cli/src");
const BASELINE_PATH = resolve(ROOT, "apps/cli/etc/cli-surface.json");

// ── Surface model ─────────────────────────────────────────────────────

interface FlagSpec {
  name: string;
  type: "string" | "boolean";
  default?: string | boolean;
  short?: string;
  multiple?: boolean;
}

export interface CliSurface {
  /** Subcommand → list of sub-subcommands (empty array if none). Keys sorted. */
  subcommands: Record<string, string[]>;
  /** Flag definitions, sorted by name for stable diffs. */
  flags: FlagSpec[];
  /**
   * Sorted unique `process.exit(N)` values used across apps/cli/src/.
   * Shell scripts wrapping motebit invocations branch on these codes.
   */
  exitCodes: number[];
  /**
   * The `~/.motebit/` paths the CLI reads or writes. Stored as literal
   * relative paths ("config.json", "relay/relay.db", etc.). Sorted.
   */
  onDiskLayout: string[];
}

// ── Subcommand extraction ─────────────────────────────────────────────

/**
 * Map from sub-subcommand variable name in index.ts to the top-level
 * parent it dispatches under. The list is small and stable; adding a new
 * family means a real surface change and an explicit update here.
 */
const SUB_SUBCOMMAND_FAMILIES: Record<string, string> = {
  approvalCmd: "approvals",
  fedCmd: "federation",
  relayCmd: "relay",
  goalCmd: "goal",
  runsCmd: "runs",
};

function extractSubcommands(): Record<string, string[]> {
  const src = readFileSync(INDEX_PATH, "utf-8");
  const result: Record<string, string[]> = {};

  // Top-level subcommands: every `if (subcommand === "X")` (and `else if`).
  const topRe = /\b(?:else\s+)?if\s*\(\s*subcommand\s*===\s*"([a-z][a-z0-9-]*)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = topRe.exec(src)) !== null) {
    const name = m[1]!;
    if (!(name in result)) result[name] = [];
  }

  // Sub-subcommand families.
  for (const [varName, parent] of Object.entries(SUB_SUBCOMMAND_FAMILIES)) {
    if (!(parent in result)) {
      throw new Error(
        `internal inconsistency: family '${varName}' maps to parent '${parent}' but parent not found among top-level subcommands`,
      );
    }
    const subRe = new RegExp(`\\b${varName}\\s*===\\s*"([a-z][a-z0-9-]*)"`, "g");
    let sm: RegExpExecArray | null;
    while ((sm = subRe.exec(src)) !== null) {
      const child = sm[1]!;
      if (!result[parent]!.includes(child)) result[parent]!.push(child);
    }
  }

  // Special case: `motebit verify identity <bundle>` — uses the generic
  // `first` positional rather than a dedicated *Cmd variable.
  if ("verify" in result) {
    const verifyBlock = src.match(
      /if\s*\(\s*subcommand\s*===\s*"verify"\s*\)\s*\{([\s\S]*?)\n\s{2}\}/,
    );
    if (verifyBlock) {
      const identityMatch = verifyBlock[1]!.match(/first\s*===\s*"([a-z][a-z0-9-]*)"/);
      if (identityMatch) {
        const child = identityMatch[1]!;
        if (!result.verify!.includes(child)) result.verify!.push(child);
      }
    }
  }

  // Sort children lexicographically; sort top-level keys at serialization.
  for (const k of Object.keys(result)) {
    result[k]!.sort();
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

// ── Flag extraction ───────────────────────────────────────────────────

/**
 * Parse the parseArgs `options:` block in args.ts. Each option takes the
 * shape:
 *   "name": { type: "string"|"boolean", default?: ..., short?: "x", multiple?: true }
 * Flag names without quotes (bare identifiers) are also valid JS object
 * keys; both forms appear in args.ts.
 */
function extractFlags(): FlagSpec[] {
  const src = readFileSync(ARGS_PATH, "utf-8");
  const optionsBlock = src.match(/options:\s*\{([\s\S]*?)\n\s{4}\},/);
  if (!optionsBlock) {
    throw new Error("could not locate `options: {...}` block in args.ts parseArgs call");
  }
  const block = optionsBlock[1]!;
  const flags: FlagSpec[] = [];

  // Match each option entry: `"name":` or `name:` followed by `{ ... }`.
  // The regex captures both forms and the inline definition.
  const entryRe = /^\s*(?:"([a-z][a-z0-9-]*)"|([a-z][a-z0-9-]*))\s*:\s*\{([^}]+)\}\s*,?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(block)) !== null) {
    const name = (m[1] ?? m[2])!;
    const body = m[3]!;
    const typeMatch = body.match(/type:\s*"(string|boolean)"/);
    if (!typeMatch) continue;
    const type = typeMatch[1] as "string" | "boolean";

    const flag: FlagSpec = { name, type };

    const defaultMatch = body.match(/default:\s*(true|false|"[^"]*")/);
    if (defaultMatch) {
      const raw = defaultMatch[1]!;
      flag.default = raw === "true" ? true : raw === "false" ? false : raw.slice(1, -1);
    }

    const shortMatch = body.match(/short:\s*"([a-z])"/);
    if (shortMatch) flag.short = shortMatch[1];

    const multipleMatch = body.match(/multiple:\s*true/);
    if (multipleMatch) flag.multiple = true;

    flags.push(flag);
  }

  flags.sort((a, b) => a.name.localeCompare(b.name));
  return flags;
}

// ── Exit code extraction ──────────────────────────────────────────────

/**
 * Extract the sorted unique set of `process.exit(N)` values used under
 * apps/cli/src/. Literal integer arguments only — dynamic exit codes
 * (e.g. `process.exit(code)`) are skipped because they're pass-through
 * to whatever policy called into them.
 */
function extractExitCodes(): number[] {
  const codes = new Set<number>();

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "__tests__") continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      const src = readFileSync(full, "utf-8");
      const re = /\bprocess\.exit\(\s*(\d+)\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        codes.add(parseInt(m[1]!, 10));
      }
    }
  }

  walk(APPS_CLI_SRC);
  return [...codes].sort((a, b) => a - b);
}

// ── On-disk layout extraction ─────────────────────────────────────────

/**
 * Extract every `path.join(CONFIG_DIR, "…")` and `path.join(RELAY_DIR, "…")`
 * reference in apps/cli/src/. Literal string arguments are stored as
 * paths relative to `~/.motebit/`:
 *
 *   path.join(CONFIG_DIR, "config.json")       → "config.json"
 *   path.join(CONFIG_DIR, "relay")             → "relay"  (the directory)
 *   path.join(RELAY_DIR,  "relay.db")          → "relay/relay.db"
 *
 * Transient files prefixed with `.` (e.g. `.doctor-test`) are filtered
 * out — they're implementation-internal, not operator-pinnable.
 */
function extractOnDiskLayout(): string[] {
  const paths = new Set<string>();

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "__tests__") continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      const src = readFileSync(full, "utf-8");

      // path.join(CONFIG_DIR, "<literal>")
      const configRe = /path\.join\(\s*CONFIG_DIR\s*,\s*"([^"]+)"\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = configRe.exec(src)) !== null) {
        if (!m[1]!.startsWith(".")) paths.add(m[1]!);
      }

      // path.join(RELAY_DIR, "<literal>")
      const relayRe = /path\.join\(\s*RELAY_DIR\s*,\s*"([^"]+)"\s*\)/g;
      while ((m = relayRe.exec(src)) !== null) {
        if (!m[1]!.startsWith(".")) paths.add(`relay/${m[1]!}`);
      }
    }
  }

  walk(APPS_CLI_SRC);
  return [...paths].sort();
}

// ── Surface assembly ──────────────────────────────────────────────────

function extractSurface(): CliSurface {
  return {
    subcommands: extractSubcommands(),
    flags: extractFlags(),
    exitCodes: extractExitCodes(),
    onDiskLayout: extractOnDiskLayout(),
  };
}

/** The committed baseline: the surface plus the major it is the contract for. */
export interface CliSurfaceBaseline extends CliSurface {
  /**
   * The `motebit` major whose contract this surface is. Stamped by `--write`
   * (see `stampForWrite`); a value ahead of the package major requires a
   * pending `motebit: major` changeset.
   */
  motebitMajor: number;
}

function canonicalJson(baseline: CliSurfaceBaseline): string {
  // Stable, prettier-compatible 2-space JSON. Keys at every level sorted.
  const { motebitMajor, ...surface } = baseline;
  return JSON.stringify({ motebitMajor, ...surface }, null, 2) + "\n";
}

function currentMotebitMajor(): number {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "apps/cli/package.json"), "utf-8")) as {
    version: string;
  };
  return Number(pkg.version.split(".")[0]);
}

// ── Pending major-bump detection (escape hatch) ───────────────────────

function hasPendingMotebitMajor(): boolean {
  const dir = resolve(ROOT, ".changeset");
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "README.md" && f !== "CHANGELOG.md",
  );
  for (const file of files) {
    const content = readFileSync(resolve(dir, file), "utf-8");
    const front = content.match(/^---\n([\s\S]*?)\n---/);
    if (!front) continue;
    for (const line of front[1]!.split("\n")) {
      const m = line.match(/^"motebit":\s*(patch|minor|major)/);
      if (m && m[1] === "major") return true;
    }
  }
  return false;
}

// ── Diff reporting ────────────────────────────────────────────────────

export interface Diff {
  kind:
    | "subcommand-added"
    | "subcommand-removed"
    | "subsubcommand-added"
    | "subsubcommand-removed"
    | "flag-added"
    | "flag-removed"
    | "flag-changed"
    | "exit-code-added"
    | "exit-code-removed"
    | "path-added"
    | "path-removed";
  detail: string;
}

/** Diff kinds that break a `motebit@X` consumer: something they used is gone or different. */
const BREAKING_KINDS: ReadonlySet<Diff["kind"]> = new Set([
  "subcommand-removed",
  "subsubcommand-removed",
  "flag-removed",
  "flag-changed",
  "exit-code-removed",
  "path-removed",
]);

export function isBreaking(d: Diff): boolean {
  return BREAKING_KINDS.has(d.kind);
}

/**
 * The `motebitMajor` stamp `--write` records. A breaking diff against the
 * previous baseline promises the NEXT major; an additive one keeps the
 * existing promise. Never decreases (re-running `--write` after a breaking
 * write must not erase the promise).
 */
export function stampForWrite(
  current: CliSurface,
  previous: CliSurfaceBaseline | null,
  pkgMajor: number,
): number {
  const prior = previous?.motebitMajor ?? pkgMajor;
  if (previous === null) return prior;
  const breaking = diffSurfaces(current, previous).some(isBreaking);
  return breaking ? Math.max(prior, pkgMajor + 1) : prior;
}

export type SurfaceVerdict =
  | { ok: true; note?: string }
  | { ok: false; reason: "drift"; diffs: Diff[] }
  | { ok: false; reason: "undeclared-major"; stamp: number; pkgMajor: number };

/** Pure decision for check mode — exported for the gate's own tests. */
export function evaluateSurface(input: {
  current: CliSurface;
  baseline: CliSurfaceBaseline;
  pkgMajor: number;
  majorPending: boolean;
}): SurfaceVerdict {
  const diffs = diffSurfaces(input.current, input.baseline);
  if (diffs.length > 0) return { ok: false, reason: "drift", diffs };
  const stamp = input.baseline.motebitMajor;
  if (stamp > input.pkgMajor) {
    if (input.majorPending) {
      return {
        ok: true,
        note: `baseline is the motebit@${stamp} contract; pending \`motebit: major\` changeset declares it`,
      };
    }
    return { ok: false, reason: "undeclared-major", stamp, pkgMajor: input.pkgMajor };
  }
  return { ok: true };
}

export function diffSurfaces(current: CliSurface, baseline: CliSurface): Diff[] {
  const diffs: Diff[] = [];

  // Top-level subcommand diff.
  const curTop = new Set(Object.keys(current.subcommands));
  const baseTop = new Set(Object.keys(baseline.subcommands));
  for (const name of curTop) {
    if (!baseTop.has(name)) diffs.push({ kind: "subcommand-added", detail: name });
  }
  for (const name of baseTop) {
    if (!curTop.has(name)) diffs.push({ kind: "subcommand-removed", detail: name });
  }

  // Sub-subcommand diff (only for parents present in both).
  for (const parent of curTop) {
    if (!baseTop.has(parent)) continue;
    const cur = new Set(current.subcommands[parent]);
    const base = new Set(baseline.subcommands[parent]);
    for (const child of cur) {
      if (!base.has(child))
        diffs.push({ kind: "subsubcommand-added", detail: `${parent} ${child}` });
    }
    for (const child of base) {
      if (!cur.has(child))
        diffs.push({ kind: "subsubcommand-removed", detail: `${parent} ${child}` });
    }
  }

  // Flag diff.
  const curFlags = new Map(current.flags.map((f) => [f.name, f]));
  const baseFlags = new Map(baseline.flags.map((f) => [f.name, f]));
  for (const [name, flag] of curFlags) {
    if (!baseFlags.has(name)) {
      diffs.push({ kind: "flag-added", detail: `--${name} (${flag.type})` });
    } else if (JSON.stringify(flag) !== JSON.stringify(baseFlags.get(name))) {
      diffs.push({
        kind: "flag-changed",
        detail: `--${name}: ${JSON.stringify(baseFlags.get(name))} → ${JSON.stringify(flag)}`,
      });
    }
  }
  for (const name of baseFlags.keys()) {
    if (!curFlags.has(name)) diffs.push({ kind: "flag-removed", detail: `--${name}` });
  }

  // Exit code diff.
  const curCodes = new Set(current.exitCodes ?? []);
  const baseCodes = new Set(baseline.exitCodes ?? []);
  for (const code of curCodes) {
    if (!baseCodes.has(code)) diffs.push({ kind: "exit-code-added", detail: String(code) });
  }
  for (const code of baseCodes) {
    if (!curCodes.has(code)) diffs.push({ kind: "exit-code-removed", detail: String(code) });
  }

  // On-disk layout diff.
  const curPaths = new Set(current.onDiskLayout ?? []);
  const basePaths = new Set(baseline.onDiskLayout ?? []);
  for (const p of curPaths) {
    if (!basePaths.has(p)) diffs.push({ kind: "path-added", detail: `~/.motebit/${p}` });
  }
  for (const p of basePaths) {
    if (!curPaths.has(p)) diffs.push({ kind: "path-removed", detail: `~/.motebit/${p}` });
  }

  return diffs;
}

// ── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const writeMode = args.includes("--write");

  const current = extractSurface();
  const pkgMajor = currentMotebitMajor();
  const previous = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as CliSurfaceBaseline)
    : null;

  if (writeMode) {
    const motebitMajor = stampForWrite(current, previous, pkgMajor);
    writeFileSync(BASELINE_PATH, canonicalJson({ motebitMajor, ...current }));
    process.stderr.write(
      `  ✓ check-cli-surface: wrote baseline (${Object.keys(current.subcommands).length} subcommands, ${current.flags.length} flags, ${current.exitCodes.length} exit codes, ${current.onDiskLayout.length} on-disk paths; motebitMajor ${motebitMajor}) to apps/cli/etc/cli-surface.json\n`,
    );
    if (motebitMajor > pkgMajor) {
      process.stderr.write(
        `  → breaking change: the baseline is now the motebit@${motebitMajor} contract — a pending \`"motebit": major\` changeset (with ## Migration) is required.\n`,
      );
    }
    return;
  }

  if (previous === null) {
    process.stderr.write(
      `\n✗ check-cli-surface: no baseline at apps/cli/etc/cli-surface.json.\n` +
        `Run \`pnpm check-cli-surface --write\` to generate one, then commit it.\n`,
    );
    process.exit(1);
  }
  if (typeof previous.motebitMajor !== "number") {
    process.stderr.write(
      `\n✗ check-cli-surface: apps/cli/etc/cli-surface.json has no \`motebitMajor\` stamp.\n` +
        `Run \`pnpm check-cli-surface --write\` to stamp it, then commit it.\n`,
    );
    process.exit(1);
  }

  const verdict = evaluateSurface({
    current,
    baseline: previous,
    pkgMajor,
    majorPending: hasPendingMotebitMajor(),
  });
  const counts = `${Object.keys(current.subcommands).length} subcommand(s), ${current.flags.length} flag(s), ${current.exitCodes.length} exit code(s), ${current.onDiskLayout.length} on-disk path(s)`;

  if (verdict.ok) {
    process.stderr.write(
      `  ✓ check-cli-surface: ${counts}, all match baseline (motebit@${previous.motebitMajor} contract; package at major ${pkgMajor}).\n`,
    );
    if (verdict.note) process.stderr.write(`    ${verdict.note}\n`);
    return;
  }

  if (verdict.reason === "undeclared-major") {
    process.stderr.write(
      `\n✗ check-cli-surface: apps/cli/etc/cli-surface.json is stamped as the motebit@${verdict.stamp} contract ` +
        `(a breaking surface change), but \`motebit\` is at major ${verdict.pkgMajor} and no pending changeset declares \`"motebit": major\`.\n\n` +
        `Add a \`"motebit": major\` changeset with a \`## Migration\` section naming the break, ` +
        `or restore the removed/changed surface and re-run \`pnpm check-cli-surface --write\`.\n`,
    );
    process.exit(1);
  }

  const diffs = verdict.diffs;
  process.stderr.write(
    `\n✗ check-cli-surface: ${diffs.length} drift(s) from baseline at apps/cli/etc/cli-surface.json.\n\n`,
  );
  const grouped: Record<string, Diff[]> = {};
  for (const d of diffs) {
    (grouped[d.kind] = grouped[d.kind] ?? []).push(d);
  }
  for (const [kind, items] of Object.entries(grouped)) {
    process.stderr.write(`  ${kind}${isBreaking(items[0]!) ? " (breaking)" : ""}:\n`);
    for (const item of items) process.stderr.write(`    - ${item.detail}\n`);
    process.stderr.write("\n");
  }
  process.stderr.write(
    "If the change is intentional, run `pnpm check-cli-surface --write` and commit\n" +
      "apps/cli/etc/cli-surface.json in this same PR (the baseline is a lockfile —\n" +
      "a pending changeset does not excuse an unwritten baseline, because\n" +
      "`changeset version` deletes it). A breaking change (anything removed or\n" +
      'changed) is stamped as the next major and also needs a `"motebit": major`\n' +
      "changeset with ## Migration. Otherwise, restore the surface to match the baseline.\n",
  );
  process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
