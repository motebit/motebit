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
 *   - PRICE — runner-owned BY CONSTRUCTION, so read from the one function
 *     that codes it. `@motebit/molecule-runner` lists exactly
 *     `MoleculeConfig.pricing` to every consumer (task admission, relay
 *     registration, the `motebit_service_listing` tool) and REFUSES at startup
 *     a `getServiceListing` that carries its own `pricing` (also a type error:
 *     `pricing?: never`). So a market service's price is whatever main() passes
 *     as config `pricing`, and this gate proves two things, nothing executed
 *     but a pure function:
 *       (a) the price: `services/<name>/src/pricing.ts` (type-only imports,
 *           types and function declarations — nothing runs at load) exports
 *           `listingPricing(env)`; imported and called with `{}` it is the
 *           `unit_cost` + `per` the docs and `.env.example` must state, and
 *           with a sentinel MOTEBIT_UNIT_COST every entry must carry it,
 *           unaltered. `0` renders as "unpriced".
 *       (b) the wiring, by TypeScript AST of `src/index.ts` (the file
 *           `node dist/index.js` — the Dockerfile CMD and `start` — boots):
 *           `runMolecule` imported by name from the runner and called exactly
 *           once (no alias, no other reference, in no other source file),
 *           with an object-literal config whose single `pricing` property is
 *           exactly `listingPricing(process.env)` — the named import from
 *           `./pricing.js`, neither name re-bound — and no spread after it.
 *     Why the AST and not a runtime "market ⇒ pricing required" check in the
 *     runner: the runner would have to find the service's package.json at
 *     runtime (deploy-layout dependent), and a missing price is a static
 *     property of one call site; the runtime half that CAN'T be static (a
 *     listing smuggling its own price, possibly after startup) is already
 *     refused by the runner. Earlier versions EXECUTED each service's main()
 *     under a captured runner and kept leaking (bound vs detached listing
 *     calls, post-construction mutation, the wrong entry, real server boots
 *     and a model download) — four review rounds, 2026-10-05; the seam was
 *     removed instead of proven. A `market: false` service reads no
 *     MOTEBIT_UNIT_COST, has no pricing.ts and never calls runMolecule.
 *
 *   THREAT MODEL — what a green run claims, and what it cannot. This gate
 *   guards ACCIDENTAL drift between the price/unit/role the docs state and the
 *   price the code passes the runner by default. The runner's own tests prove
 *   config pricing is the listing every consumer reads. It does not cover a
 *   production MOTEBIT_UNIT_COST override, a hand-edited deployment, or a
 *   runner other than this repo's: the listing a deployed service actually
 *   publishes is the one it POSTs to the relay under its signed
 *   `market:listing` token (the body itself is not signed) and the relay
 *   serves — read the production price there, never from this gate.
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
import { isDeepStrictEqual } from "node:util";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  /** Present iff the service lists: what its pure `listingPricing({})` returns. */
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

/** The service entry the deploy boots (`node dist/index.js`, compiled from this). */
export const ENTRY = "src/index.ts";
/** The pure module that codes a market service's price. */
export const PRICING = "src/pricing.ts";
/** The runner whose `runMolecule` owns the listing's pricing. */
export const RUNNER = "@motebit/molecule-runner";
/** Sentinel override: every listed entry must carry it, or it ignores the env. */
export const SENTINEL_COST = "0.123457";

interface ListingEntry {
  capability: unknown;
  unit_cost: unknown;
  currency: unknown;
  per: unknown;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Every identifier named `name` in `sf`. */
function identifiers(sf: ts.SourceFile, name: string): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  walk(sf, (n) => {
    if (ts.isIdentifier(n) && n.text === name) out.push(n);
  });
  return out;
}

/** Is `id` the NAME a declaration binds (not a use)? Property names are neither. */
function isBinding(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ((ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isBindingElement(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isImportEqualsDeclaration(p)) &&
      (p as { name?: ts.Node }).name === id) ||
    (ts.isBindingElement(p) && p.propertyName == null && p.name === id)
  );
}

/** The one value import of `name` from `module` (named, unaliased), or why not. */
function namedImport(sf: ts.SourceFile, name: string, module: string): ts.ImportSpecifier | string {
  const found: ts.ImportSpecifier[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const nb = st.importClause?.namedBindings;
    if (nb != null && ts.isNamespaceImport(nb) && from === module)
      return `\`import * as ${nb.name.text} from "${module}"\` — import \`${name}\` by name so its one call site is checkable`;
    if (st.importClause?.isTypeOnly === true || nb == null || !ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) {
      if (el.isTypeOnly || (el.propertyName ?? el.name).text !== name) continue;
      if (from !== module || el.propertyName != null)
        return `\`${name}\` is imported from "${from}"${el.propertyName != null ? ` as an alias (\`${el.name.text}\`)` : ""}, not as \`import { ${name} } from "${module}"\``;
      found.push(el);
    }
  }
  if (found.length !== 1) return `no \`import { ${name} } from "${module}"\``;
  return found[0]!;
}

/** `listingPricing(process.env)`, exactly. */
function isListingPricingOfEnv(e: ts.Expression): boolean {
  if (!ts.isCallExpression(e) || e.questionDotToken != null || e.typeArguments != null)
    return false;
  if (!ts.isIdentifier(e.expression) || e.expression.text !== "listingPricing") return false;
  if (e.arguments.length !== 1) return false;
  const a = e.arguments[0]!;
  return (
    ts.isPropertyAccessExpression(a) &&
    a.questionDotToken == null &&
    ts.isIdentifier(a.expression) &&
    a.expression.text === "process" &&
    a.name.text === "env"
  );
}

/** Strip `as T`, `satisfies T`, `!` and parentheses down to the expression. */
function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))
      e = e.expression;
    else if (ts.isNonNullExpression(e)) e = e.expression;
    else return e;
  }
}

/**
 * STRUCTURAL proof that main() hands the runner the price pricing.ts codes —
 * by the TypeScript AST of the service's sources, nothing executed.
 *
 * The runner owns the listing's pricing by construction (it lists exactly
 * `config.pricing` to every consumer and refuses a `getServiceListing` that
 * carries its own — packages/molecule-runner listing-pricing.test.ts), so the
 * one remaining seam is the call site: `runMolecule` is imported by name from
 * the runner, called exactly once (no alias, no other reference, in no other
 * source file), with an object literal whose `pricing` property is exactly
 * `listingPricing(process.env)` — `listingPricing` the named import from
 * `./pricing.js`, neither it nor `process` re-bound anywhere in the entry —
 * and no spread after it that could replace it.
 */
export function checkCallSite(root: string, name: string, violations: string[]): void {
  const srcDir = join(root, "services", name, "src");
  const entry = join(root, "services", name, ENTRY);
  const rel = relative(root, entry);
  const say = (msg: string) => violations.push(`${rel}: ${msg}`);
  if (!existsSync(entry)) {
    violations.push(`services/${name}: motebit.market is true but there is no ${ENTRY}`);
    return;
  }
  for (const f of listSourceFiles(srcDir)) {
    if (f === entry) continue;
    const sf = parse(f);
    const ids = identifiers(sf, "runMolecule");
    if (ids.length > 0)
      violations.push(
        `${relative(root, f)}:${lineOf(sf, ids[0]!)}: names \`runMolecule\` — a market service calls it once, in ${ENTRY}`,
      );
  }
  const sf = parse(entry);
  const run = namedImport(sf, "runMolecule", RUNNER);
  if (typeof run === "string") {
    say(run);
    return;
  }
  const lp = namedImport(sf, "listingPricing", "./pricing.js");
  if (typeof lp === "string") {
    say(lp);
    return;
  }
  for (const n of ["listingPricing", "process"])
    for (const id of identifiers(sf, n))
      if (isBinding(id) && id !== lp.name)
        say(
          `line ${lineOf(sf, id)} re-binds \`${n}\` — the price must be \`listingPricing(process.env)\` from ./pricing.js`,
        );
  const uses = identifiers(sf, "runMolecule").filter((id) => id !== run.name);
  const calls = uses.filter((id) => ts.isCallExpression(id.parent) && id.parent.expression === id);
  if (calls.length !== 1 || uses.length !== 1) {
    say(
      `\`runMolecule\` must be referenced exactly once, as a direct call (found ${calls.length} call(s), ${uses.length} reference(s)) — one service, one listing`,
    );
    return;
  }
  const call = calls[0]!.parent as ts.CallExpression;
  const cfg = call.arguments[0] != null ? unwrap(call.arguments[0]) : null;
  if (cfg == null || !ts.isObjectLiteralExpression(cfg)) {
    say(
      `line ${lineOf(sf, call)}: runMolecule's config must be an object literal carrying \`pricing: listingPricing(process.env)\``,
    );
    return;
  }
  const props = cfg.properties;
  const pricingAt = props.flatMap((p, i) =>
    p.name != null &&
    (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
    p.name.text === "pricing"
      ? [i]
      : [],
  );
  if (pricingAt.length !== 1) {
    say(
      `line ${lineOf(sf, call)}: runMolecule's config has ${pricingAt.length} \`pricing\` properties — exactly one, \`pricing: listingPricing(process.env)\` (the runner lists only config pricing; without it the service lists unpriced)`,
    );
    return;
  }
  const p = props[pricingAt[0]!]!;
  if (!ts.isPropertyAssignment(p) || !isListingPricingOfEnv(unwrap(p.initializer))) {
    say(
      `line ${lineOf(sf, p)}: runMolecule's \`pricing\` must be exactly \`listingPricing(process.env)\` (the pure ${PRICING} the docs are checked against), not \`${p.getText(sf).slice(0, 80)}\``,
    );
    return;
  }
  const lateSpread = props.slice(pricingAt[0]! + 1).find((q) => ts.isSpreadAssignment(q));
  if (lateSpread != null)
    say(
      `line ${lineOf(sf, lateSpread)}: a spread after \`pricing\` in runMolecule's config could replace it — put \`pricing\` after every spread`,
    );
}

/**
 * Read the price a market service lists: its pure `listingPricing`, imported
 * (never main(), never a server) and called with `{}` — the default the docs
 * must state — and with a sentinel MOTEBIT_UNIT_COST every entry must carry,
 * unaltered. `src/pricing.ts` may have type-only imports and nothing else, so
 * importing it runs no code but its own.
 */
export async function readListedPrice(
  root: string,
  name: string,
  violations: string[],
): Promise<Price | null> {
  const file = join(root, "services", name, PRICING);
  const rel = relative(root, file);
  const say = (msg: string) => violations.push(`${rel}: ${msg}`);
  if (!existsSync(file)) {
    violations.push(
      `services/${name}: motebit.market is true but there is no ${PRICING} exporting a pure \`listingPricing(env)\``,
    );
    return null;
  }
  // Pure by shape: type-only imports/re-exports, types, and function
  // declarations — nothing that runs at module load, so the gate can import it.
  const sf = parse(file);
  for (const st of sf.statements) {
    const ok =
      (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly === true) ||
      (ts.isExportDeclaration(st) && st.isTypeOnly && st.moduleSpecifier == null) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isFunctionDeclaration(st);
    if (!ok) {
      say(
        `line ${lineOf(sf, st)}: \`${st.getText(sf).split("\n")[0]!.slice(0, 60)}\` — ${PRICING} holds type-only imports, types and function declarations only (pure: importing it runs nothing)`,
      );
      return null;
    }
  }
  let fn: unknown;
  try {
    fn = ((await import(pathToFileURL(file).href)) as { listingPricing?: unknown }).listingPricing;
  } catch (err) {
    say(`could not be imported (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  if (typeof fn !== "function") {
    say("does not export a function `listingPricing`");
    return null;
  }
  const call = (env: Record<string, string>, label: string): ListingEntry[] | null => {
    let out: unknown;
    try {
      out = (fn as (e: Record<string, string>) => unknown)(Object.freeze({ ...env }));
    } catch (err) {
      say(`listingPricing(${label}) threw (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
    if (!Array.isArray(out) || out.length === 0) {
      say(
        `listingPricing(${label}) lists no pricing (${JSON.stringify(out ?? null).slice(0, 120)})`,
      );
      return null;
    }
    return out as ListingEntry[];
  };
  const entries = call({}, "{}");
  if (entries == null) return null;
  const again = call({}, "{}");
  if (again != null && !isDeepStrictEqual(again, entries))
    say(
      "listingPricing({}) returned different pricing on a second call — the price must be a pure function of the env",
    );
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
      `lists a pricing entry that is not { capability: string, unit_cost: finite ≥ 0, currency: "USD", per: string } (${JSON.stringify(bad)})`,
    );
    return null;
  }
  const costs = new Set(entries.map((e) => e.unit_cost as number));
  if (costs.size !== 1)
    say(
      `lists ${costs.size} different unit_costs (${[...costs].join(", ")}) — one service, one price`,
    );
  const pers = new Set(entries.map((e) => e.per as string));
  if (pers.size !== 1)
    say(
      `lists ${pers.size} different \`per\` units (${[...pers].join(", ")}) — the docs cannot state one price`,
    );
  const over = call(
    { MOTEBIT_UNIT_COST: SENTINEL_COST },
    `{ MOTEBIT_UNIT_COST: "${SENTINEL_COST}" }`,
  );
  if (over != null) {
    const deaf = over.filter((e) => e?.unit_cost !== Number(SENTINEL_COST));
    if (deaf.length > 0 || over.length !== entries.length)
      say(
        `with MOTEBIT_UNIT_COST="${SENTINEL_COST}" lists unit_costs ${JSON.stringify(over.map((e) => e?.unit_cost))} — every entry's unit_cost must be the parsed override, unaltered (no arithmetic, no hardcoded price)`,
      );
  }
  return {
    amount: entries[0]!.unit_cost as number,
    per: entries[0]!.per as string,
    source: `${rel} listingPricing({})`,
  };
}

/**
 * A `market: false` service is not a market participant: it reads no
 * MOTEBIT_UNIT_COST, has no ${PRICING}, and never calls `runMolecule` (which
 * registers with the relay and publishes a listing).
 */
export function checkNonMarket(root: string, name: string, violations: string[]): void {
  const srcDir = join(root, "services", name, "src");
  const say = (msg: string) => violations.push(`services/${name}: ${msg}`);
  if (existsSync(join(root, "services", name, PRICING)))
    say(`motebit.market is false but ${PRICING} exists — a priced listing is a market participant`);
  for (const f of listSourceFiles(srcDir)) {
    const text = readFileSync(f, "utf8");
    if (text.includes("MOTEBIT_UNIT_COST"))
      say(
        `motebit.market is false but ${relative(root, f)} reads MOTEBIT_UNIT_COST — a priced listing is a market participant`,
      );
    if (!text.includes("runMolecule")) continue;
    const sf = parse(f);
    const call = identifiers(sf, "runMolecule").find(
      (id) => ts.isCallExpression(id.parent) && id.parent.expression === id,
    );
    if (call != null)
      say(
        `motebit.market is false but ${relative(root, f)}:${lineOf(sf, call)} calls runMolecule — a runMolecule service registers and lists on the relay`,
      );
  }
}

/**
 * The entry this gate reads must be the one the deploy boots: a Dockerfile's
 * CMD and package.json `start` (when present) run `node dist/index.js`, the
 * compiled ${ENTRY}.
 */
export function checkBootEntry(root: string, name: string, violations: string[]): void {
  const dir = join(root, "services", name);
  const docker = join(dir, "Dockerfile");
  if (existsSync(docker)) {
    const cmd = readFileSync(docker, "utf8")
      .split("\n")
      .filter((l) => /^\s*(?:CMD|ENTRYPOINT)\b/.test(l));
    if (cmd.length !== 1 || !/^\s*CMD \["node", "dist\/index\.js"\]\s*$/.test(cmd[0]!))
      violations.push(
        `services/${name}/Dockerfile: must boot exactly \`CMD ["node", "dist/index.js"]\` (the compiled ${ENTRY} whose runMolecule call is checked) — found ${JSON.stringify(cmd)}`,
      );
  }
  const start = (
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: { start?: unknown };
    }
  ).scripts?.start;
  if (start != null && start !== "node dist/index.js")
    violations.push(
      `services/${name}/package.json: scripts.start is ${JSON.stringify(start)} — a market service starts \`node dist/index.js\` (the compiled ${ENTRY})`,
    );
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
    if ("listingProbeEnv" in m)
      violations.push(
        `services/${name}/package.json: motebit.listingProbeEnv is retired — the gate no longer boots services; remove it`,
      );
    const v: string[] = [];
    let price: Price | null = null;
    if (market) {
      price = await readListedPrice(root, name, v);
      checkCallSite(root, name, v);
      checkBootEntry(root, name, v);
    } else {
      checkNonMarket(root, name, v);
    }
    checkEnvExample(root, name, price, market, v);
    violations.push(...v);
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
        "role/identity/market: the `motebit` block in services/<name>/package.json; price: the pure `listingPricing(env)` in services/<name>/src/pricing.ts, called with `{}` (no MOTEBIT_UNIT_COST), which main() must pass runMolecule as exactly `pricing: listingPricing(process.env)` — the runner lists only config pricing and refuses a listing that brings its own",
      fix: "correct README.md § Architecture and apps/docs/content/docs/operator/architecture.mdx (tree + § Services table + counts) to match the canonical source — the coded default wins, docs conform. A market service: keep its price in src/pricing.ts (pure; one price, one `per`, MOTEBIT_UNIT_COST overrides every entry unaltered) and call runMolecule once in src/index.ts with `pricing: listingPricing(process.env)` after any spread; never put `pricing` in getServiceListing. .env.example states the coded default. A new service: add its `motebit` block, then name it once in each inventory. Re-run `pnpm check-service-truth`.",
      doctrine: "docs/drift-defenses.md (#173)",
    });
  }
  const market = r.services.filter((s) => s.market).length;
  console.log(
    `✓ check-service-truth: ${r.services.length} services' metadata + coded listing prices (${market} market listings) agree with ${r.placements} placement(s) and ${r.countClaims} count claim(s) in ${README_PATH} § Architecture and ${ARCHITECTURE_PATH} (tree + § Services). Aperture: proves these two docs and each .env.example match services/*/package.json and each market service's pure ${PRICING} listingPricing({}) (and that a sentinel MOTEBIT_UNIT_COST reaches every entry unaltered); proves by TypeScript AST that each market service's ${ENTRY} — the file its Dockerfile CMD / start boots as dist/index.js — calls runMolecule exactly once with \`pricing: listingPricing(process.env)\` (the runner lists only config pricing and refuses a getServiceListing carrying its own — molecule-runner listing-pricing.test.ts); market:false services read no MOTEBIT_UNIT_COST, have no pricing.ts and call no runMolecule. Nothing is executed but those pure functions: no server boots, no network, no ports. Threat model: guards ACCIDENTAL drift between documented and coded price/unit/role; it does not cover production MOTEBIT_UNIT_COST overrides or hand-edited deployments — the deployed listing is the one the service POSTs to the relay (signed market:listing token) and the relay serves; read the production price there. Not covered: other docs pages; "identity" is declared metadata, not verified against code.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
