/**
 * check-service-truth — every service's role, market exposure and price is
 * stated once, and the two hand-written service inventories agree with it.
 *
 * Two facts, two canonical sources:
 *
 *   - ROLE / IDENTITY / MARKET — the `motebit` block in each
 *     `services/<name>/package.json`:
 *       { "role": "relay" | "molecule" | "atom" | "infrastructure",
 *         "identity": boolean, "market": boolean }
 *     `market` = the service has an identity and lists on the market. The
 *     marketplace count is the number of `market: true` services.
 *
 *   - PRICE — what the service actually LISTS, obtained by EXECUTION: the
 *     gate runs each listing service's real entry (`src/index.ts`, its real
 *     main()) in a child process whose `@motebit/molecule-runner` is the real
 *     package except `runMolecule`, swapped by module hooks for a capture
 *     (scripts/lib/listing-probe/). The capture calls the builder main() handed
 *     the runner and then the `getServiceListing` that builder returned — the
 *     exact function the runner publishes to the relay — and the `pricing` it
 *     resolves to under an env with no MOTEBIT_UNIT_COST is the price the docs
 *     must state (`unit_cost` + `per`). A second run with a sentinel
 *     MOTEBIT_UNIT_COST must list it, unaltered, in every entry. Nothing about
 *     the listing is read from source: earlier versions read the literal after
 *     `?? "…"`, then matched a `pricing: listingPricing(process.env)` site, and
 *     both stayed green while main() listed something else (a renamed, dead
 *     `getServiceListing`; a post-construction rewrite of `per`; a spread
 *     override; a different object) — cold reviews, 2026-10-05. Never copied
 *     into metadata; the listed default wins, docs conform. `0` renders as
 *     "unpriced". A `market: true` service MUST list non-empty pricing when
 *     executed; a `market: false` service MUST NOT read MOTEBIT_UNIT_COST and,
 *     if it imports the runner, MUST list no pricing when executed. A service
 *     whose main() needs env to boot declares inert values in
 *     `motebit.listingProbeEnv` (never MOTEBIT_UNIT_COST). Each
 *     `.env.example`'s MOTEBIT_UNIT_COST (and any "default: N" above it) must
 *     equal the executed default.
 *
 * The derived surfaces (both hand-written prose, so both checked):
 *
 *   - README.md, `## Architecture` up to the `**Protocol**` paragraph: the role
 *     bullets (`- **Molecules** — …`) and every count stated in prose.
 *   - apps/docs/content/docs/operator/architecture.mdx: the `services/` tree
 *     (`├── <name>/  [role]  desc`), the `## Services` role table's services
 *     column, and the counts in that section's prose.
 *
 * In each inventory every service appears exactly once, under the role its
 * metadata names, carrying the price its code names (`$X/<unit>`, or the word
 * "unpriced" when the coded default is 0; no price at all when it does not
 * list). Counts bound to a role word ("4 molecule agents", "Eleven services in
 * four roles", "7 list on the market") must equal what the metadata derives.
 * The retired role label "glue" is refused in both inventories.
 *
 * Born 2026-10-05: README said web-search $0.05/request and read-url unpriced;
 * architecture.mdx said $0.003 and $0.002; the code said $0.05 and 0; `proxy`
 * was labelled "glue" and `embed` (no identity, no MCP listing) an atom.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { failWithRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export const ROLES = ["relay", "molecule", "atom", "infrastructure"] as const;
export type ServiceRole = (typeof ROLES)[number];

export const README_PATH = "README.md";
export const ARCHITECTURE_PATH = "apps/docs/content/docs/operator/architecture.mdx";

/** Doc labels for each role — README bullet / architecture table first cell. */
const LABEL_ROLE: Record<string, ServiceRole> = {
  "the relay": "relay",
  relay: "relay",
  molecules: "molecule",
  atoms: "atom",
  infrastructure: "infrastructure",
};

export interface Price {
  /** Dollars, as the coded default parses (`parseFloat`). */
  amount: number;
  /** The listing's `per` unit, or null when the code lists no unit. */
  per: string | null;
  /** Repo-relative file the default was read from. */
  source: string;
}

export interface ServiceTruth {
  name: string;
  role: ServiceRole;
  identity: boolean;
  market: boolean;
  /** Present iff the service lists: the pricing its executed main() hands the runner. */
  price: Price | null;
}

export interface Evaluation {
  violations: string[];
  services: ServiceTruth[];
  /** How many count claims in prose were compared against the metadata. */
  countClaims: number;
  /** How many (service, inventory) placements were checked. */
  placements: number;
}

// ── canonical: metadata + code ──────────────────────────────────────────────

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(entry) && !/\.test\.[a-z]+$/.test(entry)) out.push(p);
  }
  return out;
}

/** The service entry the probe runs — what `node dist/index.js` boots. */
export const ENTRY = "src/index.ts";
/** The runner whose `runMolecule` is the fleet's listing path. */
export const RUNNER = "@motebit/molecule-runner";
/** Sentinel override: every listed entry must carry it, or it ignores the env. */
const SENTINEL_COST = "0.123457";
const PROBE_CHILD = join(__dirname, "lib", "listing-probe", "child.mjs");
const PROBE_TIMEOUT_MS = 60_000;

interface ListingEntry {
  capability: unknown;
  unit_cost: unknown;
  currency: unknown;
  per: unknown;
}

/** One `runMolecule(config, build)` call the probe captured. */
export interface CapturedCall {
  serviceName: string | null;
  /** Whether the MoleculeBuild the builder returned carries `getServiceListing`. */
  hasGetServiceListing?: boolean;
  /** What that `getServiceListing()` resolved to (JSON round-tripped). */
  listing?: { pricing?: unknown } | null;
  /** The builder or the listing threw. */
  error?: string;
}

export interface ProbeRun {
  calls: CapturedCall[];
  exitCode: number | null;
  /** Set when the child produced no result (crash before the exit hook, timeout). */
  failure?: string;
  stderrTail: string;
}

/**
 * EXECUTE a service's real entry and capture what it hands the runner.
 *
 * Spawns `node --import tsx scripts/lib/listing-probe/child.mjs <entry>` with a
 * scrubbed env (`PATH`, a throwaway `HOME`/cwd, the service's declared
 * `listingProbeEnv`, plus `extraEnv`). Module hooks swap `runMolecule` — and
 * nothing else — for a capture that calls the service's own builder with a
 * fresh identity and then the `getServiceListing` it returned: the exact
 * function the real runner publishes to the relay. So the listing read here is
 * the one main() lists, whatever main() does to build it — no source pattern
 * is consulted. Workspace imports resolve to built `dist/` (run `pnpm build`).
 */
export function probeListing(
  entry: string,
  probeEnv: Record<string, string>,
  extraEnv: Record<string, string> = {},
): Promise<ProbeRun> {
  const work = mkdtempSync(join(tmpdir(), "service-truth-probe-"));
  const out = join(work, "result.json");
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: work,
    TMPDIR: tmpdir(),
    ...probeEnv,
    ...extraEnv,
  };
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(TSX_LOADER).href, PROBE_CHILD, entry, out],
      { cwd: work, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderrTail = stderr.trim().split("\n").slice(-3).join(" ⏎ ").slice(-400);
      let run: ProbeRun;
      try {
        const r = JSON.parse(readFileSync(out, "utf8")) as {
          calls: CapturedCall[];
          exitCode: number;
        };
        run = { calls: r.calls, exitCode: r.exitCode, stderrTail };
      } catch {
        run = {
          calls: [],
          exitCode: code,
          stderrTail,
          failure: timedOut
            ? `did not call runMolecule within ${PROBE_TIMEOUT_MS / 1000}s`
            : `the probe child died without a result (exit ${code})`,
        };
      }
      rmSync(work, { recursive: true, force: true });
      done(run);
    });
  });
}

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

/** Does any non-test source file of the service import the runner? */
function importsRunner(srcDir: string): boolean {
  const re = new RegExp(`(?:from|import)\\s*\\(?\\s*["']${RUNNER.replace("/", "\\/")}["']`);
  return listSourceFiles(srcDir).some((f) => re.test(readFileSync(f, "utf8")));
}

function describeRun(run: ProbeRun): string {
  const why = run.failure ?? `exit ${run.exitCode}`;
  return `${why}${run.stderrTail !== "" ? ` — stderr: ${run.stderrTail}` : ""}${
    /Cannot find (?:module|package)/.test(run.stderrTail)
      ? " (the probe runs the entry against built workspace packages: run `pnpm build`)"
      : ""
  }`;
}

/**
 * Read the price a service LISTS, by running it. A `market: true` service's
 * real entry must call `runMolecule` exactly once, with a builder whose
 * `getServiceListing()` returns a non-empty, well-formed `pricing` array of
 * one `unit_cost` and one `per`: that listing, under an env with no
 * MOTEBIT_UNIT_COST, is the price the docs must state. Run again with a
 * sentinel MOTEBIT_UNIT_COST, every entry must carry it unaltered (the
 * override reaches the whole listing; no arithmetic, no hardcode). A
 * `market: false` service may not read MOTEBIT_UNIT_COST anywhere in its
 * source, and if it imports the runner its executed listing must carry no
 * pricing.
 */
export async function readListedPrice(
  root: string,
  name: string,
  market: boolean,
  probeEnv: Record<string, string>,
  violations: string[],
): Promise<Price | null> {
  const srcDir = join(root, "services", name, "src");
  const entry = join(root, "services", name, ENTRY);
  const entryRel = relative(root, entry);
  const say = (msg: string) => violations.push(`services/${name}: ${msg}`);

  if (!market) {
    const envReads = listSourceFiles(srcDir)
      .filter((f) => readFileSync(f, "utf8").includes("MOTEBIT_UNIT_COST"))
      .map((f) => relative(root, f));
    if (envReads.length > 0)
      say(
        `motebit.market is false but ${envReads.join(", ")} reads MOTEBIT_UNIT_COST — a priced listing is a market participant`,
      );
    if (!existsSync(entry) || !importsRunner(srcDir)) return null;
    const run = await probeListing(entry, probeEnv);
    if (run.failure != null && run.calls.length === 0) {
      // Imports the runner but never reached it in time: fail closed.
      say(`imports ${RUNNER} but executing ${entryRel} could not be read (${describeRun(run)})`);
      return null;
    }
    for (const c of run.calls) {
      if (c.error != null)
        say(`executing ${entryRel}: the builder handed to runMolecule threw (${c.error})`);
      const pricing = c.listing?.pricing;
      if (Array.isArray(pricing) && pricing.length > 0)
        say(
          `motebit.market is false but executing ${entryRel} lists pricing ${JSON.stringify(pricing).slice(0, 160)} — a priced listing is a market participant`,
        );
    }
    return null;
  }

  if (!existsSync(entry)) {
    say(`motebit.market is true but there is no ${ENTRY} to execute`);
    return null;
  }
  const [dflt, sentinel] = await Promise.all([
    probeListing(entry, probeEnv),
    probeListing(entry, probeEnv, { MOTEBIT_UNIT_COST: SENTINEL_COST }),
  ]);
  const listed = (run: ProbeRun, label: string): ListingEntry[] | null => {
    if (run.calls.length === 0) {
      say(
        `motebit.market is true but executing ${entryRel}${label} never called runMolecule (${describeRun(run)})${
          Object.keys(probeEnv).length === 0
            ? ` — if main() needs env to boot, declare inert values in package.json motebit.listingProbeEnv`
            : ""
        }`,
      );
      return null;
    }
    if (run.calls.length > 1) {
      say(
        `executing ${entryRel}${label} called runMolecule ${run.calls.length} times — one service, one listing`,
      );
      return null;
    }
    const c = run.calls[0]!;
    if (c.error != null) {
      say(`executing ${entryRel}${label}: the builder or its getServiceListing threw (${c.error})`);
      return null;
    }
    if (c.hasGetServiceListing !== true) {
      say(
        `motebit.market is true but the build ${entryRel} hands runMolecule has no getServiceListing — the relay lists it with no pricing`,
      );
      return null;
    }
    const pricing = c.listing?.pricing;
    if (!Array.isArray(pricing) || pricing.length === 0) {
      say(
        `motebit.market is true but executing ${entryRel}'s getServiceListing()${label} lists no pricing (${JSON.stringify(c.listing ?? null).slice(0, 120)})`,
      );
      return null;
    }
    return pricing as ListingEntry[];
  };
  const entries = listed(dflt, "");
  if (entries == null) return null;
  const bad = entries.find(
    (e) =>
      e == null ||
      typeof e.capability !== "string" ||
      typeof e.unit_cost !== "number" ||
      !Number.isFinite(e.unit_cost) ||
      e.unit_cost < 0 ||
      e.currency !== "USD" ||
      typeof e.per !== "string",
  );
  if (bad != null) {
    say(
      `executing ${entryRel} lists a pricing entry that is not { capability: string, unit_cost: finite ≥ 0, currency: "USD", per: string } (${JSON.stringify(bad)})`,
    );
    return null;
  }
  const costs = new Set(entries.map((e) => e.unit_cost as number));
  if (costs.size !== 1)
    say(
      `executing ${entryRel} lists ${costs.size} different unit_costs (${[...costs].join(", ")}) — one service, one price`,
    );
  const pers = new Set(entries.map((e) => e.per as string));
  if (pers.size !== 1)
    say(
      `executing ${entryRel} lists ${pers.size} different \`per\` units (${[...pers].join(", ")}) — the docs cannot state one price`,
    );
  const over = listed(sentinel, ` with MOTEBIT_UNIT_COST="${SENTINEL_COST}"`);
  if (over != null) {
    const deaf = over.filter((e) => e?.unit_cost !== Number(SENTINEL_COST));
    if (deaf.length > 0 || over.length !== entries.length)
      say(
        `with MOTEBIT_UNIT_COST="${SENTINEL_COST}", executing ${entryRel} lists unit_costs ${JSON.stringify(over.map((e) => e?.unit_cost))} — every entry's unit_cost must be the parsed override, unaltered (no arithmetic, no hardcoded price)`,
      );
  }
  return {
    amount: entries[0]!.unit_cost as number,
    per: entries[0]!.per as string,
    source: `${entryRel} (executed)`,
  };
}

/**
 * `.env.example` is what an operator copies: its MOTEBIT_UNIT_COST — set or
 * commented out — and any "default: N" in the comment just above it must be
 * the price the service lists by default. The coded default wins.
 */
export function checkEnvExample(
  root: string,
  name: string,
  price: Price | null,
  market: boolean,
  violations: string[],
): void {
  const path = join(root, "services", name, ".env.example");
  if (!existsSync(path)) return;
  const rel = relative(root, path);
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = /^\s*#?\s*MOTEBIT_UNIT_COST\s*=\s*([^\s#]*)/.exec(line);
    if (m == null) return;
    const where = `${rel}:${i + 1}`;
    if (!market) {
      violations.push(`${where}: MOTEBIT_UNIT_COST on a service whose motebit.market is false`);
      return;
    }
    if (price == null) return; // the listing could not be read — already reported
    const stated: { v: number; at: string }[] = [];
    if (m[1] !== "") stated.push({ v: Number.parseFloat(m[1]!), at: `MOTEBIT_UNIT_COST=${m[1]}` });
    for (let j = i - 1; j >= 0 && /^\s*#/.test(lines[j]!); j--) {
      const d = /\bdefault:?\s*\$?(\d+(?:\.\d+)?)/i.exec(lines[j]!);
      if (d != null) stated.push({ v: Number.parseFloat(d[1]!), at: `"${d[0]}" (line ${j + 1})` });
    }
    for (const s of stated)
      if (s.v !== price.amount)
        violations.push(
          `${where}: ${s.at} but ${price.source} lists $${price.amount}/${price.per} by default — the example must state the coded default`,
        );
  });
}

/** Every services/* directory — the set the inventories must cover. */
export function serviceDirs(root: string): string[] {
  const dir = join(root, "services");
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
    .sort();
}

export async function readServices(root: string, violations: string[]): Promise<ServiceTruth[]> {
  const dir = join(root, "services");
  const pending: { svc: Omit<ServiceTruth, "price">; probeEnv: Record<string, string> }[] = [];
  for (const name of serviceDirs(root)) {
    const pkgPath = join(dir, name, "package.json");
    if (!existsSync(pkgPath)) {
      violations.push(`services/${name}: no package.json, so no \`motebit\` service metadata`);
      continue;
    }
    const meta = (JSON.parse(readFileSync(pkgPath, "utf8")) as { motebit?: unknown }).motebit;
    if (meta == null || typeof meta !== "object") {
      violations.push(
        `services/${name}/package.json: missing the \`motebit\` service metadata block`,
      );
      continue;
    }
    const m = meta as Record<string, unknown>;
    const role = m["role"];
    if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
      violations.push(
        `services/${name}/package.json: motebit.role ${JSON.stringify(role)} is not one of ${ROLES.join(" | ")}`,
      );
      continue;
    }
    if (typeof m["identity"] !== "boolean" || typeof m["market"] !== "boolean") {
      violations.push(
        `services/${name}/package.json: motebit.identity and motebit.market must both be booleans`,
      );
      continue;
    }
    const identity = m["identity"];
    const market = m["market"];
    if (market && !identity) {
      violations.push(
        `services/${name}/package.json: motebit.market is true but motebit.identity is false — only a service with an identity can list on the market`,
      );
    }
    const probeEnv = m["listingProbeEnv"] ?? {};
    if (
      typeof probeEnv !== "object" ||
      probeEnv === null ||
      Object.values(probeEnv).some((v) => typeof v !== "string")
    ) {
      violations.push(
        `services/${name}/package.json: motebit.listingProbeEnv must be an object of string values`,
      );
      continue;
    }
    if ("MOTEBIT_UNIT_COST" in probeEnv) {
      violations.push(
        `services/${name}/package.json: motebit.listingProbeEnv may not set MOTEBIT_UNIT_COST — the probe reads the price main() lists by default`,
      );
      continue;
    }
    pending.push({
      svc: { name, role: role as ServiceRole, identity, market },
      probeEnv: probeEnv as Record<string, string>,
    });
  }
  // Probe every service concurrently; report in directory order.
  const results = await Promise.all(
    pending.map(async ({ svc, probeEnv }) => {
      const v: string[] = [];
      const price = await readListedPrice(root, svc.name, svc.market, probeEnv, v);
      checkEnvExample(root, svc.name, price, svc.market, v);
      return { truth: { ...svc, price }, v };
    }),
  );
  for (const r of results) violations.push(...r.v);
  return results.map((r) => r.truth);
}

// ── derived: the two inventories ────────────────────────────────────────────

interface Placement {
  name: string;
  role: ServiceRole | null;
  /** The text after the name up to the next service name (price search span). */
  annotation: string;
  where: string;
}

const PRICE_RE = /\$(\d+(?:\.\d+)?)\/([a-z_]+)/;

/** Find every backticked service name in a segment, with its annotation span. */
function placementsIn(
  segment: string,
  role: ServiceRole | null,
  known: Set<string>,
  where: string,
): Placement[] {
  const hits: { name: string; start: number; end: number }[] = [];
  for (const m of segment.matchAll(/`([a-z][a-z0-9-]*)`/g)) {
    if (known.has(m[1]!)) hits.push({ name: m[1]!, start: m.index!, end: m.index! + m[0].length });
  }
  return hits.map((h, i) => ({
    name: h.name,
    role,
    annotation: segment.slice(h.end, hits[i + 1]?.start ?? segment.length),
    where,
  }));
}

function checkPrice(svc: ServiceTruth, p: Placement, violations: string[]): void {
  const priceMatch = PRICE_RE.exec(p.annotation);
  const unpricedAt = p.annotation.search(/\bunpriced\b/i);
  const priceAt = priceMatch?.index ?? -1;
  const say = (msg: string) => violations.push(`${p.where}: \`${svc.name}\` ${msg}`);
  if (svc.price == null) {
    if (priceAt >= 0)
      say(
        `states $${priceMatch![1]}/${priceMatch![2]} but the service does not list on the market (motebit.market is false)`,
      );
    return;
  }
  const { amount, per, source } = svc.price;
  if (amount === 0) {
    if (unpricedAt < 0 || (priceAt >= 0 && priceAt < unpricedAt))
      say(`must say "unpriced" — ${source} lists unit_cost 0 by default`);
    return;
  }
  const want = `$${amount}${per != null ? `/${per}` : ""}`;
  if (priceAt < 0 || (unpricedAt >= 0 && unpricedAt < priceAt)) {
    say(`states no price — ${source} lists ${want}`);
    return;
  }
  const docAmount = Number.parseFloat(priceMatch![1]!);
  const docPer = priceMatch![2]!;
  if (docAmount !== amount || (per != null && docPer !== per))
    say(`states $${priceMatch![1]}/${docPer} but ${source} lists ${want}`);
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/** Count claims: a number immediately followed by a role/market word. */
function checkCounts(
  text: string,
  where: string,
  services: ServiceTruth[],
  violations: string[],
): number {
  const byRole = (r: ServiceRole) => services.filter((s) => s.role === r).length;
  const expected: { re: RegExp; label: string; value: number }[] = [
    { re: /^services?\b/i, label: "services", value: services.length },
    { re: /^roles?\b/i, label: "roles", value: new Set(services.map((s) => s.role)).size },
    { re: /^relays?\b/i, label: "relay", value: byRole("relay") },
    { re: /^molecules?\b/i, label: "molecule", value: byRole("molecule") },
    { re: /^atoms?\b/i, label: "atom", value: byRole("atom") },
    { re: /^infrastructure\b/i, label: "infrastructure", value: byRole("infrastructure") },
    {
      re: /^(?:list\b|marketplace\b|market\b)/i,
      label: "market (identity + listing)",
      value: services.filter((s) => s.market).length,
    },
  ];
  let claims = 0;
  const numRe = new RegExp(
    `\\b(\\d+|${Object.keys(NUMBER_WORDS).join("|")})\\s+(?=[A-Za-z])`,
    "gi",
  );
  for (const m of text.matchAll(numRe)) {
    const rest = text.slice(m.index! + m[0].length);
    const hit = expected.find((e) => e.re.test(rest));
    if (hit == null) continue;
    claims++;
    const raw = m[1]!.toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]!;
    if (n !== hit.value) {
      const phrase = `${m[1]} ${/^[A-Za-z-]+(?:[ \t]+[A-Za-z-]+)?/.exec(rest)?.[0] ?? ""}`;
      violations.push(
        `${where}: count claim "${phrase}" — the metadata derives ${hit.value} ${hit.label}`,
      );
    }
  }
  return claims;
}

function sliceBetween(
  text: string,
  start: RegExp,
  end: RegExp,
): { body: string; line: number } | null {
  const s = start.exec(text);
  if (s == null) return null;
  const after = text.slice(s.index);
  const e = end.exec(after.slice(1));
  const body = e == null ? after : after.slice(0, e.index + 1);
  return { body, line: text.slice(0, s.index).split("\n").length };
}

function checkInventory(
  inventory: string,
  placements: Placement[],
  services: ServiceTruth[],
  violations: string[],
): void {
  const byName = new Map(services.map((s) => [s.name, s]));
  const seen = new Map<string, number>();
  for (const p of placements) {
    seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
    const svc = byName.get(p.name);
    if (svc == null) continue; // broken metadata — already reported
    if (p.role == null) {
      violations.push(
        `${p.where}: \`${p.name}\` sits under an unrecognised role label (use The relay / Molecules / Atoms / Infrastructure)`,
      );
    } else if (p.role !== svc.role) {
      violations.push(
        `${p.where}: \`${p.name}\` is listed as ${p.role} but services/${p.name}/package.json motebit.role is ${svc.role}`,
      );
    }
    // A listing whose price could not be read is already reported; don't guess.
    if (!(svc.market && svc.price == null)) checkPrice(svc, p, violations);
  }
  for (const s of services) {
    const n = seen.get(s.name) ?? 0;
    if (n === 0) violations.push(`${inventory}: service \`${s.name}\` (${s.role}) is not named`);
    else if (n > 1)
      violations.push(
        `${inventory}: service \`${s.name}\` is named ${n} times — name it exactly once`,
      );
  }
}

function roleOfLabel(label: string): ServiceRole | null {
  return LABEL_ROLE[label.trim().toLowerCase()] ?? null;
}

export async function evaluate(root: string): Promise<Evaluation> {
  const violations: string[] = [];
  const services = await readServices(root, violations);
  // Placements are recognised against every services/* directory, so a service
  // whose metadata is broken still parses as itself (and is reported once, as
  // broken metadata, not again as an unknown name).
  const dirs = serviceDirs(root);
  const known = new Set(dirs);
  const complete = services.length === dirs.length;
  let countClaims = 0;
  let placements = 0;

  // README.md — `## Architecture` through the `**Protocol**` paragraph.
  const readme = readFileSync(join(root, README_PATH), "utf8");
  const rRegion = sliceBetween(readme, /^## Architecture\s*$/m, /^\*\*Protocol\*\*/m);
  if (rRegion == null) {
    violations.push(
      `${README_PATH}: no \`## Architecture\` section — the services inventory moved`,
    );
  } else {
    if (/\bglue\b/i.test(rRegion.body))
      violations.push(
        `${README_PATH} § Architecture: the role "glue" is retired — say Infrastructure`,
      );
    if (complete)
      countClaims += checkCounts(
        rRegion.body,
        `${README_PATH} § Architecture`,
        services,
        violations,
      );
    const ps: Placement[] = [];
    rRegion.body.split("\n").forEach((line, i) => {
      const b = /^- \*\*([^*]+)\*\*\s*[—-]\s*(.*)$/.exec(line);
      if (b == null) return;
      ps.push(
        ...placementsIn(b[2]!, roleOfLabel(b[1]!), known, `${README_PATH}:${rRegion.line + i}`),
      );
    });
    placements += ps.length;
    checkInventory(`${README_PATH} § Architecture (services bullets)`, ps, services, violations);
  }

  // architecture.mdx — the tree and the `## Services` table.
  const arch = readFileSync(join(root, ARCHITECTURE_PATH), "utf8");
  const archLines = arch.split("\n");
  const treeStart = archLines.findIndex((l) => /^[├└]── services\/\s*$/.test(l));
  if (treeStart < 0) {
    violations.push(`${ARCHITECTURE_PATH}: no \`├── services/\` node in the directory tree`);
  } else {
    const ps: Placement[] = [];
    for (let i = treeStart + 1; i < archLines.length; i++) {
      const line = archLines[i]!;
      if (/^[├└]── /.test(line) || line.trim() === "```") break;
      const t = /^│?\s+[├└]── ([a-z][a-z0-9-]*)\/\s+\[([a-z-]+)\]\s*(.*)$/.exec(line);
      if (t == null) continue;
      if (/^glue$/i.test(t[2]!))
        violations.push(
          `${ARCHITECTURE_PATH}:${i + 1}: the role "glue" is retired — say [infrastructure]`,
        );
      const role = (ROLES as readonly string[]).includes(t[2]!) ? (t[2] as ServiceRole) : null;
      if (!known.has(t[1]!)) {
        violations.push(
          `${ARCHITECTURE_PATH}:${i + 1}: tree names \`${t[1]}\` but services/${t[1]} does not exist`,
        );
        continue;
      }
      ps.push({ name: t[1]!, role, annotation: t[3]!, where: `${ARCHITECTURE_PATH}:${i + 1}` });
    }
    placements += ps.length;
    checkInventory(`${ARCHITECTURE_PATH} (services/ tree)`, ps, services, violations);
  }

  const sRegion = sliceBetween(arch, /^## Services\s*$/m, /^## /m);
  if (sRegion == null) {
    violations.push(`${ARCHITECTURE_PATH}: no \`## Services\` section`);
  } else {
    if (/\bglue\b/i.test(sRegion.body))
      violations.push(
        `${ARCHITECTURE_PATH} § Services: the role "glue" is retired — say Infrastructure`,
      );
    const prose = sRegion.body
      .split("\n")
      .filter((l) => !l.startsWith("|"))
      .join("\n");
    if (complete)
      countClaims += checkCounts(prose, `${ARCHITECTURE_PATH} § Services`, services, violations);
    const ps: Placement[] = [];
    sRegion.body.split("\n").forEach((line, i) => {
      const row = /^\|\s*\*\*([^*]+)\*\*\s*\|([^|]*)\|/.exec(line);
      if (row == null) return;
      ps.push(
        ...placementsIn(
          row[2]!,
          roleOfLabel(row[1]!),
          known,
          `${ARCHITECTURE_PATH}:${sRegion.line + i}`,
        ),
      );
    });
    placements += ps.length;
    checkInventory(`${ARCHITECTURE_PATH} § Services (table)`, ps, services, violations);
  }

  return { violations, services, countClaims, placements };
}

async function main(): Promise<void> {
  const argRoot = process.argv.indexOf("--root");
  const root = argRoot >= 0 ? resolve(process.argv[argRoot + 1] ?? ".") : ROOT;
  const r = await evaluate(root);
  if (r.violations.length > 0) {
    failWithRepair({
      invariant: `check-service-truth: ${r.violations.length} service-inventory drift(s) — a doc disagrees with the service's metadata or coded price`,
      sites: r.violations,
      canonical:
        "role/identity/market: the `motebit` block in services/<name>/package.json; price: the `pricing` (unit_cost + per) of the listing services/<name>/src/index.ts's main() hands runMolecule, read by executing it with no MOTEBIT_UNIT_COST set (scripts/lib/listing-probe/)",
      fix: "correct README.md § Architecture and apps/docs/content/docs/operator/architecture.mdx (tree + § Services table + counts) to match the canonical source — the listed default wins, docs conform. A market service's main() must hand runMolecule a builder whose getServiceListing() lists one non-empty price that MOTEBIT_UNIT_COST overrides in every entry; if main() needs env to boot, declare inert values in motebit.listingProbeEnv. .env.example states the coded default. A new service: add its `motebit` block, then name it once in each inventory. Re-run `pnpm check-service-truth`.",
      doctrine: "docs/drift-defenses.md (#173)",
    });
  }
  const market = r.services.filter((s) => s.market).length;
  console.log(
    `✓ check-service-truth: ${r.services.length} services' metadata + executed listing prices (${market} market listings, each read by executing the service's main() and calling the getServiceListing it hands runMolecule) agree with ${r.placements} placement(s) and ${r.countClaims} count claim(s) in ${README_PATH} § Architecture and ${ARCHITECTURE_PATH} (tree + § Services). Aperture: proves these two docs and each .env.example match services/*/package.json and the price each market service's real main() lists by default when executed (runMolecule captured, everything else real; required env from motebit.listingProbeEnv); market:false services are executed only if they import ${RUNNER}, else checked for MOTEBIT_UNIT_COST reads — nothing about deployed listings, MOTEBIT_UNIT_COST overrides in prod, or other pages of the docs site; "identity" is declared metadata, not verified against code.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
