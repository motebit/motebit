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
 *   - PRICE — what the service actually LISTS, obtained by EXECUTION: every
 *     listing service codes its price once, in `src/pricing.ts` as a pure,
 *     import-free `listingPricing(env)`, and lists exactly
 *     `pricing: listingPricing(process.env)`. The gate runs that function (in
 *     an isolated vm context) with an empty env — the price main() lists by
 *     default, `unit_cost` + `per` — and with a sentinel MOTEBIT_UNIT_COST that
 *     every entry must carry unaltered. Arithmetic or a hardcoded price inside
 *     the function shows up in what it returns; one outside it is refused
 *     structurally (no `unit_cost`, no MOTEBIT_UNIT_COST read, no other
 *     `pricing` value anywhere else in the service's source). Execution, not a
 *     source pattern: an earlier version read the literal after
 *     `?? "…"` and stayed green on `parseFloat(…) * 2` and on a hardcoded
 *     `unit_cost: 0.5` in the listing (cold review, 2026-10-05). Never copied
 *     into metadata; the listed default wins, docs conform. `0` renders as
 *     "unpriced". A `market: true` service MUST have the module, a
 *     `market: false` service MUST NOT (nor any MOTEBIT_UNIT_COST read) — so
 *     the market flag is tied to the code that actually lists.
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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";
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
  /** Present iff the service lists: what its executed `listingPricing({})` returns. */
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

/** The one module a listing service codes its price in, and its export. */
export const PRICING_MODULE = "pricing.ts";
export const PRICING_EXPORT = "listingPricing";
/** Sentinel override: every listed entry must carry it, or it ignores the env. */
const SENTINEL_COST = "0.123457";

interface ListingEntry {
  capability: unknown;
  unit_cost: unknown;
  currency: unknown;
  per: unknown;
}

/**
 * EXECUTE `services/<name>/src/pricing.ts`'s `listingPricing(env)` — the same
 * function main() lists — and return what it lists. Transpiled to CommonJS and
 * run in a fresh `vm` context with no `require`, no `process`, no globals but
 * the language built-ins: the module must be pure and read only the injected
 * env, or it throws here and the service fails closed. Arithmetic, hardcoding,
 * fallback chains — whatever the function does is what the gate sees.
 */
export function executeListingPricing(
  file: string,
  env: Record<string, string>,
): { entries: ListingEntry[] } | { error: string } {
  const out = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const mod = { exports: {} as Record<string, unknown> };
  try {
    vm.runInNewContext(out.outputText, { module: mod, exports: mod.exports }, { timeout: 1000 });
    const fn = mod.exports[PRICING_EXPORT];
    if (typeof fn !== "function") return { error: `exports no \`${PRICING_EXPORT}\` function` };
    const result: unknown = (fn as (e: Record<string, string>) => unknown)(
      Object.freeze({ ...env }),
    );
    if (!Array.isArray(result) || result.length === 0)
      return { error: `${PRICING_EXPORT}(env) returned no pricing entries` };
    return { entries: result as ListingEntry[] };
  } catch (err) {
    // Errors thrown inside the vm come from another realm: not `instanceof Error`.
    const msg =
      err != null && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : String(err);
    return {
      error: `did not execute purely (${msg}) — it may import nothing and read only its \`env\` parameter`,
    };
  }
}

const isEnvRead = (n: ts.Node): boolean =>
  (ts.isStringLiteralLike(n) || ts.isIdentifier(n)) && n.text === "MOTEBIT_UNIT_COST";
const isUnitCost = (n: ts.Node): boolean =>
  (ts.isStringLiteralLike(n) || ts.isIdentifier(n)) && n.text === "unit_cost";

/** `pricing: listingPricing(process.env)` — the only listing shape accepted. */
function isCanonicalListing(init: ts.Expression): boolean {
  if (!ts.isCallExpression(init) || init.arguments.length !== 1) return false;
  if (!ts.isIdentifier(init.expression) || init.expression.text !== PRICING_EXPORT) return false;
  const a = init.arguments[0]!;
  return (
    ts.isPropertyAccessExpression(a) &&
    ts.isIdentifier(a.expression) &&
    a.expression.text === "process" &&
    a.name.text === "env"
  );
}

/**
 * Read the price a service LISTS. A listing service (`market: true`) codes its
 * price in exactly one place — `src/pricing.ts`'s pure `listingPricing(env)` —
 * and its source lists exactly `pricing: listingPricing(process.env)`, imported
 * from that module; nothing else in its source may read MOTEBIT_UNIT_COST, name
 * `unit_cost`, or build a `pricing` value. The price is then read by EXECUTING
 * the function with an empty env (the default the docs state) and with a
 * sentinel MOTEBIT_UNIT_COST (every entry must carry it). A non-listing service
 * may have neither a pricing module nor a MOTEBIT_UNIT_COST read.
 */
export function readCodedPrice(
  root: string,
  name: string,
  market: boolean,
  violations: string[],
): Price | null {
  const srcDir = join(root, "services", name, "src");
  const pricingFile = join(srcDir, PRICING_MODULE);
  const pricingRel = relative(root, pricingFile);
  const hasModule = existsSync(pricingFile);
  const envReads: string[] = [];
  const unitCosts: string[] = [];
  const listings: string[] = [];
  const badListings: string[] = [];
  const shadows: string[] = [];
  let imported = false;
  for (const file of listSourceFiles(srcDir)) {
    if (file === pricingFile) continue;
    const rel = relative(root, file);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const visit = (n: ts.Node): void => {
      if (isEnvRead(n)) envReads.push(at(n));
      if (market) {
        if (isUnitCost(n)) unitCosts.push(at(n));
        if (
          ts.isImportDeclaration(n) &&
          ts.isStringLiteral(n.moduleSpecifier) &&
          resolve(dirname(file), n.moduleSpecifier.text.replace(/\.js$/, ".ts")) === pricingFile &&
          n.importClause?.namedBindings != null &&
          ts.isNamedImports(n.importClause.namedBindings) &&
          n.importClause.namedBindings.elements.some(
            (e) => e.name.text === PRICING_EXPORT && e.propertyName == null,
          )
        )
          imported = true;
        if (
          (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) &&
          n.name != null &&
          ts.isIdentifier(n.name) &&
          n.name.text === PRICING_EXPORT
        )
          shadows.push(at(n));
        if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "pricing") {
          if (isCanonicalListing(n.initializer)) listings.push(at(n));
          else badListings.push(`${at(n)} (\`${n.initializer.getText(sf).slice(0, 60)}\`)`);
        }
        if (ts.isShorthandPropertyAssignment(n) && n.name.text === "pricing")
          badListings.push(`${at(n)} (shorthand \`pricing\`)`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  if (!market) {
    if (hasModule || envReads.length > 0)
      violations.push(
        `services/${name}: motebit.market is false but ${hasModule ? pricingRel : envReads.join(", ")} codes a MOTEBIT_UNIT_COST price — a priced listing is a market participant`,
      );
    return null;
  }

  const say = (msg: string) => violations.push(`services/${name}: ${msg}`);
  if (!hasModule) {
    say(
      `motebit.market is true but there is no ${PRICING_MODULE} — a listing codes its price in src/${PRICING_MODULE} as \`export function ${PRICING_EXPORT}(env)\` (0 = unpriced)`,
    );
    return null;
  }
  if (envReads.length > 0)
    say(
      `MOTEBIT_UNIT_COST is read outside ${pricingRel} (${envReads.join(", ")}) — the price is coded in one place, the function the listing calls`,
    );
  if (unitCosts.length > 0)
    say(
      `\`unit_cost\` appears outside ${pricingRel} (${[...new Set(unitCosts)].join(", ")}) — the listing's price must be exactly what ${PRICING_EXPORT}(env) returns, never set or rewritten elsewhere`,
    );
  if (badListings.length > 0)
    say(
      `a \`pricing\` value other than \`${PRICING_EXPORT}(process.env)\` (${badListings.join(", ")}) — list exactly \`pricing: ${PRICING_EXPORT}(process.env)\``,
    );
  if (listings.length !== 1)
    say(
      `${listings.length} \`pricing: ${PRICING_EXPORT}(process.env)\` listing site(s) — main() must list exactly one (found: ${listings.join(", ") || "none"})`,
    );
  if (!imported)
    say(
      `no source file imports { ${PRICING_EXPORT} } from ./${PRICING_MODULE.replace(/\.ts$/, ".js")}`,
    );
  if (shadows.length > 0)
    say(`\`${PRICING_EXPORT}\` is redeclared outside ${pricingRel} (${shadows.join(", ")})`);

  const dflt = executeListingPricing(pricingFile, {});
  if ("error" in dflt) {
    violations.push(`${pricingRel}: ${dflt.error}`);
    return null;
  }
  const bad = dflt.entries.find(
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
    violations.push(
      `${pricingRel}: ${PRICING_EXPORT}({}) lists an entry that is not { capability: string, unit_cost: finite ≥ 0, currency: "USD", per: string } (${JSON.stringify(bad)})`,
    );
    return null;
  }
  const costs = new Set(dflt.entries.map((e) => e.unit_cost as number));
  if (costs.size !== 1)
    violations.push(
      `${pricingRel}: ${PRICING_EXPORT}({}) lists ${costs.size} different unit_costs (${[...costs].join(", ")}) — one service, one price`,
    );
  const pers = new Set(dflt.entries.map((e) => e.per as string));
  if (pers.size !== 1)
    violations.push(
      `${pricingRel}: listing declares ${pers.size} different \`per\` units (${[...pers].join(", ")}) — the docs cannot state one price`,
    );
  const sentinel = executeListingPricing(pricingFile, { MOTEBIT_UNIT_COST: SENTINEL_COST });
  if ("error" in sentinel) violations.push(`${pricingRel}: ${sentinel.error}`);
  else {
    const deaf = sentinel.entries.filter((e) => e?.unit_cost !== Number(SENTINEL_COST));
    if (deaf.length > 0 || sentinel.entries.length !== dflt.entries.length)
      violations.push(
        `${pricingRel}: with MOTEBIT_UNIT_COST="${SENTINEL_COST}", ${PRICING_EXPORT} lists ${JSON.stringify(sentinel.entries.map((e) => e?.unit_cost))} — every entry's unit_cost must be the parsed override, unaltered (no arithmetic, no hardcoded price)`,
      );
  }
  return {
    amount: dflt.entries[0]!.unit_cost as number,
    per: dflt.entries[0]!.per as string,
    source: pricingRel,
  };
}

/** Every services/* directory — the set the inventories must cover. */
export function serviceDirs(root: string): string[] {
  const dir = join(root, "services");
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
    .sort();
}

export function readServices(root: string, violations: string[]): ServiceTruth[] {
  const dir = join(root, "services");
  const out: ServiceTruth[] = [];
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
    const price = readCodedPrice(root, name, market, violations);
    out.push({ name, role: role as ServiceRole, identity, market, price });
  }
  return out;
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
    say(`states no price — ${source} codes ${want}`);
    return;
  }
  const docAmount = Number.parseFloat(priceMatch![1]!);
  const docPer = priceMatch![2]!;
  if (docAmount !== amount || (per != null && docPer !== per))
    say(`states $${priceMatch![1]}/${docPer} but ${source} codes ${want}`);
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

export function evaluate(root: string): Evaluation {
  const violations: string[] = [];
  const services = readServices(root, violations);
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

function main(): void {
  const argRoot = process.argv.indexOf("--root");
  const root = argRoot >= 0 ? resolve(process.argv[argRoot + 1] ?? ".") : ROOT;
  const r = evaluate(root);
  if (r.violations.length > 0) {
    failWithRepair({
      invariant: `check-service-truth: ${r.violations.length} service-inventory drift(s) — a doc disagrees with the service's metadata or coded price`,
      sites: r.violations,
      canonical:
        "role/identity/market: the `motebit` block in services/<name>/package.json; price: what services/<name>/src/pricing.ts `listingPricing(env)` returns when executed with an empty env (unit_cost + per), listed by main() as exactly `pricing: listingPricing(process.env)`",
      fix: "correct README.md § Architecture and apps/docs/content/docs/operator/architecture.mdx (tree + § Services table + counts) to match the canonical source — the listed default wins, docs conform. A listing service codes its price only in src/pricing.ts `listingPricing(env)` (pure, import-free) and lists `pricing: listingPricing(process.env)`. A new service: add its `motebit` block, then name it once in each inventory. Re-run `pnpm check-service-truth`.",
      doctrine: "docs/drift-defenses.md (#173)",
    });
  }
  const market = r.services.filter((s) => s.market).length;
  console.log(
    `✓ check-service-truth: ${r.services.length} services' metadata + executed listing prices (${market} market listings, each read by running its listingPricing({})) agree with ${r.placements} placement(s) and ${r.countClaims} count claim(s) in ${README_PATH} § Architecture and ${ARCHITECTURE_PATH} (tree + § Services). Aperture: proves these two docs match services/*/package.json and the price each listing service's own listingPricing() returns by default, and that main() lists exactly that function's output — nothing about deployed listings, MOTEBIT_UNIT_COST overrides in prod, or other pages of the docs site; "identity" is declared metadata, not verified against code.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
