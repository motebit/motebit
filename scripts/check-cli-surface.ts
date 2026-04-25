/**
 * CLI-surface drift gate — locks the operator-facing contract of the
 * `motebit` reference runtime to a committed baseline.
 *
 * The motebit package's stability promise is its bundled operator-facing
 * surface (subcommands, flags, exit codes, `~/.motebit/` layout, relay
 * HTTP routes, MCP server tool list), per `apps/cli/README.md` "How it
 * ships". The Apache-2.0 protocol packages have `check-api-surface` to
 * mechanically enforce the .d.ts side of their 1.0; until 2026-04-24
 * the CLI promise rested on changeset discipline alone — same word,
 * different rigor. This gate closes that asymmetry.
 *
 * Five sub-surfaces covered:
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
 *   3. Relay HTTP routes — every `app.<method>("<path>", ...)` declared
 *      across `services/api/src/*.ts`. `motebit relay up` imports
 *      `createSyncRelay` from `@motebit/api`, so the services/api route
 *      tree IS the HTTP surface a `motebit relay up` operator exposes
 *      to their network. Operators pin curl calls and federation peers
 *      against these paths; silent drift breaks their integrations.
 *
 *   4. Exit codes — the sorted set of unique `process.exit(N)` values
 *      used anywhere under `apps/cli/src/`. Shell scripts wrapping
 *      motebit invocations branch on exit codes; {0, 1, 2, 130} is the
 *      current contract. A new non-zero code is additive but should be
 *      declared; removing 130 would break scripts that check SIGINT.
 *
 *   5. On-disk layout — the `~/.motebit/` paths referenced in the CLI
 *      source (config, database, identity, relay subdirectory, relay
 *      database). Operators pin scripts against these paths; renaming
 *      `config.json` or moving `relay.db` out of `~/.motebit/relay/`
 *      breaks their integrations. Transient files prefixed with `.` are
 *      intentionally excluded — they're implementation detail.
 *
 * The last sub-surface the original commitment named — MCP server tool
 * list exposed by `motebit serve` — is tracked as a follow-up that
 * extends this same baseline file.
 *
 * Strategy:
 *   - Extract the current surface from source.
 *   - Compare to the committed baseline at `apps/cli/etc/cli-surface.json`.
 *   - Fail on any drift unless a `.changeset/*.md` declares `motebit: major`.
 *   - To intentionally change the surface: regenerate the baseline with
 *     `pnpm check-cli-surface --write` and commit the diff alongside the
 *     `motebit: major` changeset.
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
const SERVICES_API_SRC = resolve(ROOT, "services/api/src");
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

interface RouteSpec {
  method: "get" | "post" | "put" | "delete" | "patch";
  path: string;
}

interface CliSurface {
  /** Subcommand → list of sub-subcommands (empty array if none). Keys sorted. */
  subcommands: Record<string, string[]>;
  /** Flag definitions, sorted by name for stable diffs. */
  flags: FlagSpec[];
  /**
   * Relay HTTP routes exposed by `motebit relay up` (via @motebit/api).
   * Extracted from services/api/src/*.ts. Sorted by path then method.
   */
  relayRoutes: RouteSpec[];
  /**
   * Sorted unique non-`process.exit(N)` values used across apps/cli/src/.
   * Shell scripts wrapping motebit invocations branch on these codes.
   */
  exitCodes: number[];
  /**
   * The `~/.motebit/` paths the CLI reads or writes. Stored as literal
   * relative paths ("config.json", "relay/relay.db", etc.); "." and ""
   * indicate the directory root. Sorted.
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

// ── Relay route extraction ────────────────────────────────────────────

/**
 * Walk every .ts file under services/api/src/ (excluding __tests__ and
 * .d.ts), extract `app.<method>("<path>", ...)` calls. The same route
 * declared in two files is de-duplicated. Result sorted by path then
 * method for stable diffs.
 */
function extractRelayRoutes(): RouteSpec[] {
  const seen = new Set<string>();
  const routes: RouteSpec[] = [];

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
      const re = /\bapp\.(get|post|put|delete|patch)\(\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const method = m[1] as RouteSpec["method"];
        const path = m[2]!;
        const key = `${method} ${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push({ method, path });
      }
    }
  }

  walk(SERVICES_API_SRC);

  routes.sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    return byPath !== 0 ? byPath : a.method.localeCompare(b.method);
  });
  return routes;
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
    relayRoutes: extractRelayRoutes(),
    exitCodes: extractExitCodes(),
    onDiskLayout: extractOnDiskLayout(),
  };
}

function canonicalJson(surface: CliSurface): string {
  // Stable, prettier-compatible 2-space JSON. Keys at every level sorted.
  return JSON.stringify(surface, null, 2) + "\n";
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

interface Diff {
  kind:
    | "subcommand-added"
    | "subcommand-removed"
    | "subsubcommand-added"
    | "subsubcommand-removed"
    | "flag-added"
    | "flag-removed"
    | "flag-changed"
    | "route-added"
    | "route-removed"
    | "exit-code-added"
    | "exit-code-removed"
    | "path-added"
    | "path-removed";
  detail: string;
}

function diffSurfaces(current: CliSurface, baseline: CliSurface): Diff[] {
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

  // Relay route diff.
  const routeKey = (r: RouteSpec): string => `${r.method.toUpperCase()} ${r.path}`;
  const curRoutes = new Set((current.relayRoutes ?? []).map(routeKey));
  const baseRoutes = new Set((baseline.relayRoutes ?? []).map(routeKey));
  for (const key of curRoutes) {
    if (!baseRoutes.has(key)) diffs.push({ kind: "route-added", detail: key });
  }
  for (const key of baseRoutes) {
    if (!curRoutes.has(key)) diffs.push({ kind: "route-removed", detail: key });
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
  const currentJson = canonicalJson(current);

  if (writeMode) {
    writeFileSync(BASELINE_PATH, currentJson);
    process.stderr.write(
      `  ✓ check-cli-surface: wrote baseline (${Object.keys(current.subcommands).length} subcommands, ${current.flags.length} flags, ${current.relayRoutes.length} relay routes, ${current.exitCodes.length} exit codes, ${current.onDiskLayout.length} on-disk paths) to apps/cli/etc/cli-surface.json\n`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    process.stderr.write(
      `\n✗ check-cli-surface: no baseline at apps/cli/etc/cli-surface.json.\n` +
        `Run \`pnpm check-cli-surface --write\` to generate one, then commit it.\n`,
    );
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as CliSurface;
  const diffs = diffSurfaces(current, baseline);

  if (diffs.length === 0) {
    process.stderr.write(
      `  ✓ check-cli-surface: ${Object.keys(current.subcommands).length} subcommand(s), ${current.flags.length} flag(s), ${current.relayRoutes.length} relay route(s), ${current.exitCodes.length} exit code(s), ${current.onDiskLayout.length} on-disk path(s), all match baseline.\n`,
    );
    return;
  }

  // Surface changed. Accept iff a major bump is pending — else fail with
  // the diff named.
  const majorPending = hasPendingMotebitMajor();
  if (majorPending) {
    process.stderr.write(
      `  ⚠ check-cli-surface: ${diffs.length} surface change(s) detected, accepted by pending \`motebit: major\` changeset.\n`,
    );
    for (const d of diffs) {
      process.stderr.write(`    ${d.kind}: ${d.detail}\n`);
    }
    process.stderr.write(
      `  → Run \`pnpm check-cli-surface --write\` to refresh the baseline before publishing.\n`,
    );
    return;
  }

  process.stderr.write(
    `\n✗ check-cli-surface: ${diffs.length} drift(s) from baseline at apps/cli/etc/cli-surface.json.\n\n`,
  );
  const grouped: Record<string, Diff[]> = {};
  for (const d of diffs) {
    (grouped[d.kind] = grouped[d.kind] ?? []).push(d);
  }
  for (const [kind, items] of Object.entries(grouped)) {
    process.stderr.write(`  ${kind}:\n`);
    for (const item of items) process.stderr.write(`    - ${item.detail}\n`);
    process.stderr.write("\n");
  }
  process.stderr.write(
    "If this change is intentional and breaking for `motebit@X.0` consumers,\n" +
      "ship a `motebit: major` changeset and run `pnpm check-cli-surface --write` to\n" +
      "refresh the baseline. Otherwise, restore the surface to match the baseline.\n",
  );
  process.exit(1);
}

main();
