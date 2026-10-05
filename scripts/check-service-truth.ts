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
 *   - PRICE — runner-owned BY CONSTRUCTION, coded once as DATA.
 *     `@motebit/molecule-runner` lists exactly `MoleculeConfig.pricing` to every
 *     consumer (task admission, relay registration, the
 *     `motebit_service_listing` tool) and REFUSES at startup a
 *     `getServiceListing` that carries its own `pricing` (also a type error:
 *     `pricing?: never`). `pricing` is a `ListingPriceSpec` — one capability
 *     list, one `unit_cost`, one `per` — and the runner alone reads the
 *     operator override MOTEBIT_UNIT_COST, once, through its pure
 *     `resolveListingPricing` (packages/molecule-runner/src/listing-price.ts):
 *     a malformed value refuses the boot, never lists NaN. This gate proves
 *     three things, executing nothing but that zero-import runner rule:
 *       (a) the price: `services/<name>/src/pricing.ts` is, by TypeScript AST,
 *           type-only imports/types plus ONE `export const LISTING_PRICE =
 *           { capabilities: [..], unit_cost: <number>, per: "<unit>" }` of
 *           literals, naming no `process` / `globalThis` / `import.meta` /
 *           `require` — so it CANNOT read the environment (cold review R5,
 *           2026-10-05: the previous `listingPricing(env)` could read a second
 *           override key, pick `per` from the env, or branch on
 *           `process.env`, and stay green because the gate only called it
 *           with `{}` and a sentinel). `unit_cost` + `per` are what the docs
 *           and `.env.example` must state. `0` renders as "unpriced".
 *       (b) the override rule: the runner's `resolveListingPricing` lists the
 *           spec with no override, carries a sentinel MOTEBIT_UNIT_COST to
 *           every entry unaltered, and THROWS on every malformed value in
 *           MALFORMED_COSTS ("abc", "", "-1", "1e3", "0.20abc", …).
 *       (c) the wiring, by TypeScript AST of `src/index.ts` (the file
 *           `node dist/index.js` — the Dockerfile CMD and `start` — boots):
 *           `runMolecule` imported by name from the runner and called exactly
 *           once (no alias, no other reference, in no other source file),
 *           with an object-literal config whose single `pricing` property is
 *           exactly `LISTING_PRICE` — the named import from `./pricing.js`,
 *           not re-bound and named nowhere else, no other file importing the
 *           price module — and no spread after it.
 *     Why the AST and not a runtime "market ⇒ pricing required" check in the
 *     runner: the runner would have to find the service's package.json at
 *     runtime (deploy-layout dependent), and a missing price is a static
 *     property of one call site; the runtime half that CAN'T be static (a
 *     listing smuggling its own price, possibly after startup; a malformed
 *     override) is already refused by the runner. Earlier versions EXECUTED
 *     each service's main() under a captured runner and kept leaking — four
 *     review rounds, 2026-10-05; the seam was removed instead of proven, and
 *     R5 removed the next one (env in the price module) the same way. A
 *     `market: false` service reads no MOTEBIT_UNIT_COST, has no pricing.ts
 *     and never calls runMolecule.
 *       (d) env discipline, EVERY service, by TypeScript AST of every non-test
 *           source under src/: MOTEBIT_UNIT_COST is named nowhere in code
 *           (identifier, property key, string or template literal — comments
 *           are not code), and nothing writes process.env (assignment of any
 *           operator incl. `??=`/`||=`, `++`/`--`, `delete`,
 *           `Object.assign`/`defineProperty`/`Reflect.set` on it). Cold review
 *           R6 (2026-10-05): `process.env["MOTEBIT_UNIT_COST"] ??= "0.30"` at
 *           the top of main() (or in a helper) stayed green while research
 *           listed $0.30 against the $0.25 its pricing.ts and docs state.
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
  /** Present iff the service lists: its `LISTING_PRICE` as the runner lists it with no override. */
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

/** Does this import/export/dynamic-import specifier name the price module? */
const PRICING_SPEC = /(?:^|\/)pricing(?:\.[cm]?[jt]s)?$/;

/** Every module specifier in `sf` (static imports, re-exports, `import()`, `require()`). */
function specifiers(sf: ts.SourceFile): { text: string; node: ts.Node }[] {
  const out: { text: string; node: ts.Node }[] = [];
  walk(sf, (n) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier != null &&
      ts.isStringLiteral(n.moduleSpecifier)
    )
      out.push({ text: n.moduleSpecifier.text, node: n });
    else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === "require")) &&
      n.arguments[0] != null
    )
      out.push({
        text: ts.isStringLiteralLike(n.arguments[0]) ? n.arguments[0].text : "<dynamic>",
        node: n,
      });
  });
  return out;
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
 * the identifier `LISTING_PRICE` — the named import from `./pricing.js`,
 * named nowhere else in the entry (so nothing can mutate it before the call)
 * and not re-bound — and no spread after it that could replace it. No other
 * source file imports the price module or names `LISTING_PRICE`.
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
  const pricingFile = join(root, "services", name, PRICING);
  for (const f of listSourceFiles(srcDir)) {
    if (f === entry || f === pricingFile) continue;
    const sf = parse(f);
    const ids = identifiers(sf, "runMolecule");
    if (ids.length > 0)
      violations.push(
        `${relative(root, f)}:${lineOf(sf, ids[0]!)}: names \`runMolecule\` — a market service calls it once, in ${ENTRY}`,
      );
    const lp = identifiers(sf, "LISTING_PRICE")[0];
    const imp = specifiers(sf).find((x) => PRICING_SPEC.test(x.text));
    if (lp != null || imp != null)
      violations.push(
        `${relative(root, f)}:${lineOf(sf, lp ?? imp!.node)}: ${lp != null ? "names `LISTING_PRICE`" : `imports "${imp!.text}"`} — only ${ENTRY} reads the price module, once, as runMolecule's \`pricing\``,
      );
  }
  const sf = parse(entry);
  const run = namedImport(sf, "runMolecule", RUNNER);
  if (typeof run === "string") {
    say(run);
    return;
  }
  const lp = namedImport(sf, "LISTING_PRICE", "./pricing.js");
  if (typeof lp === "string") {
    say(lp);
    return;
  }
  const otherImports = specifiers(sf).filter(
    (x) => PRICING_SPEC.test(x.text) && x.node !== lp.parent.parent.parent,
  );
  for (const x of otherImports)
    say(
      `line ${lineOf(sf, x.node)}: imports "${x.text}" again — the price module is read once, as \`import { LISTING_PRICE } from "./pricing.js"\``,
    );
  for (const id of identifiers(sf, "LISTING_PRICE"))
    if (isBinding(id) && id !== lp.name)
      say(
        `line ${lineOf(sf, id)} re-binds \`LISTING_PRICE\` — the price must be the one imported from ./pricing.js`,
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
      `line ${lineOf(sf, call)}: runMolecule's config must be an object literal carrying \`pricing: LISTING_PRICE\``,
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
      `line ${lineOf(sf, call)}: runMolecule's config has ${pricingAt.length} \`pricing\` properties — exactly one, \`pricing: LISTING_PRICE\` (the runner lists only config pricing; without it the service lists unpriced)`,
    );
    return;
  }
  const p = props[pricingAt[0]!]!;
  const value = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : null;
  if (value == null || !ts.isIdentifier(value) || value.text !== "LISTING_PRICE") {
    say(
      `line ${lineOf(sf, p)}: runMolecule's \`pricing\` must be exactly \`LISTING_PRICE\` (the literal data in ${PRICING} the docs are checked against; the runner applies MOTEBIT_UNIT_COST), not \`${p.getText(sf).slice(0, 80)}\``,
    );
    return;
  }
  const refs = identifiers(sf, "LISTING_PRICE").filter((id) => id !== lp.name && id !== value);
  for (const id of refs)
    say(
      `line ${lineOf(sf, id)}: names \`LISTING_PRICE\` outside runMolecule's \`pricing\` — the price is handed to the runner untouched, once`,
    );
  const lateSpread = props.slice(pricingAt[0]! + 1).find((q) => ts.isSpreadAssignment(q));
  if (lateSpread != null)
    say(
      `line ${lineOf(sf, lateSpread)}: a spread after \`pricing\` in runMolecule's config could replace it — put \`pricing\` after every spread`,
    );
}

/** Identifiers through which a module could read the environment. */
const AMBIENT = ["process", "globalThis", "global", "window", "self", "Deno", "Bun", "require"];

/** The literal value of a `LISTING_PRICE` property, or null when it is not one. */
function literalOf(e: ts.Expression): string | number | string[] | null {
  if (ts.isStringLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isArrayLiteralExpression(e) && e.elements.every((x) => ts.isStringLiteral(x)))
    return e.elements.map((x) => (x as ts.StringLiteral).text);
  return null;
}

/**
 * The override rule, proven where it lives: the runner's pure
 * `resolveListingPricing` (packages/molecule-runner/src/listing-price.ts,
 * zero imports) — the function runMolecule lists every price through. With
 * no override every entry is the spec; a sentinel MOTEBIT_UNIT_COST reaches
 * every entry unaltered; a malformed one THROWS (the boot refuses) instead of
 * listing NaN. Checked once per run against the repo's own runner.
 */
export const RUNNER_RULE = "packages/molecule-runner/src/listing-price.ts";

type Resolve = (spec: unknown, raw: string | undefined) => ListingEntry[];
let resolver: Promise<Resolve | string> | null = null;

function runnerRule(): Promise<Resolve | string> {
  resolver ??= (async () => {
    const file = join(ROOT, RUNNER_RULE);
    try {
      const m = (await import(pathToFileURL(file).href)) as { resolveListingPricing?: unknown };
      if (typeof m.resolveListingPricing !== "function")
        return `${RUNNER_RULE}: does not export \`resolveListingPricing\``;
      const fn = m.resolveListingPricing as Resolve;
      const spec = Object.freeze({ capabilities: ["a", "b"], unit_cost: 0.25, per: "task" });
      const plain = JSON.stringify(fn(spec, undefined));
      const want = (c: number) =>
        JSON.stringify(
          ["a", "b"].map((capability) => ({
            capability,
            unit_cost: c,
            currency: "USD",
            per: "task",
          })),
        );
      if (plain !== want(0.25))
        return `${RUNNER_RULE}: resolveListingPricing(spec, no override) lists ${plain} — must be the spec, one entry per capability, USD`;
      const over = JSON.stringify(fn(spec, SENTINEL_COST));
      if (over !== want(Number(SENTINEL_COST)))
        return `${RUNNER_RULE}: with MOTEBIT_UNIT_COST="${SENTINEL_COST}" lists ${over} — every entry's unit_cost must be the parsed override, unaltered`;
      for (const bad of MALFORMED_COSTS) {
        let listed: unknown;
        try {
          listed = fn(spec, bad);
        } catch {
          continue;
        }
        return `${RUNNER_RULE}: MOTEBIT_UNIT_COST override rule accepts ${JSON.stringify(bad)} (lists ${JSON.stringify(listed)}) — a malformed override must refuse the boot, never list`;
      }
      return fn;
    } catch (err) {
      return `${RUNNER_RULE}: could not be imported or threw on a valid price (${err instanceof Error ? err.message : String(err)})`;
    }
  })();
  return resolver;
}

/** Overrides the runner must refuse (throw) rather than list. */
export const MALFORMED_COSTS = ["abc", "", " ", "-1", "NaN", "Infinity", "1e3", "0.20abc", "0x10"];

/**
 * Read the price a market service lists. `src/pricing.ts` is DATA — the
 * TypeScript AST must show type-only imports/exports and types, plus exactly
 * one `export const LISTING_PRICE = { capabilities: [<string>…], unit_cost:
 * <number>, per: <string> }` of literals (no spread, no computed key, no
 * expression), and no identifier through which code could reach the
 * environment (`process`, `globalThis`, `import.meta`, …). So the module
 * cannot read MOTEBIT_UNIT_COST, a second key, or choose `per` at runtime:
 * the one override is the runner's. Nothing in it is executed; the listed
 * default is what the runner's own `resolveListingPricing` makes of it.
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
      `services/${name}: motebit.market is true but there is no ${PRICING} exporting \`LISTING_PRICE\` (literal data)`,
    );
    return null;
  }
  const sf = parse(file);
  let ambient = false;
  walk(sf, (n) => {
    const hit =
      ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword
        ? "import.meta"
        : ts.isIdentifier(n) && AMBIENT.includes(n.text)
          ? n.text
          : null;
    if (hit == null) return;
    ambient = true;
    say(
      `line ${lineOf(sf, n)}: names \`${hit}\` — the price module cannot read the environment; MOTEBIT_UNIT_COST is read and validated by the runner alone (${RUNNER_RULE})`,
    );
  });
  const shape = `${PRICING} holds type-only imports, types and ONE \`export const LISTING_PRICE: ListingPriceSpec = { capabilities: ["…"], unit_cost: <number>, per: "…" }\` of literals — data the runner prices, never code that reads the env`;
  let decl: ts.VariableDeclaration | null = null;
  for (const st of sf.statements) {
    const typeOnly =
      (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly === true) ||
      (ts.isExportDeclaration(st) && st.isTypeOnly && st.moduleSpecifier == null) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st);
    if (typeOnly) continue;
    const d =
      ts.isVariableStatement(st) &&
      decl == null &&
      (st.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      st.modifiers?.length === 1 &&
      st.modifiers[0]!.kind === ts.SyntaxKind.ExportKeyword &&
      st.declarationList.declarations.length === 1
        ? st.declarationList.declarations[0]!
        : null;
    if (d == null || !ts.isIdentifier(d.name) || d.name.text !== "LISTING_PRICE") {
      say(`line ${lineOf(sf, st)}: \`${st.getText(sf).split("\n")[0]!.slice(0, 60)}\` — ${shape}`);
      return null;
    }
    decl = d;
  }
  if (decl == null) {
    say(`exports no \`LISTING_PRICE\` — ${shape}`);
    return null;
  }
  if (ambient) return null;
  let init = decl.initializer;
  if (init != null && ts.isSatisfiesExpression(init)) init = init.expression;
  if (init == null || !ts.isObjectLiteralExpression(init)) {
    say(`line ${lineOf(sf, decl)}: LISTING_PRICE is not an object literal — ${shape}`);
    return null;
  }
  const props = new Map<string, string | number | string[]>();
  for (const p of init.properties) {
    const key =
      ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
        ? p.name.text
        : null;
    const value = key != null && ts.isPropertyAssignment(p) ? literalOf(p.initializer) : null;
    if (key == null || value == null || props.has(key)) {
      say(
        `line ${lineOf(sf, p)}: \`${p.getText(sf).slice(0, 60)}\` — every LISTING_PRICE property is a plain \`key: <literal>\`, once (no spread, computed key, getter or expression)`,
      );
      return null;
    }
    props.set(key, value);
  }
  const caps = props.get("capabilities");
  const cost = props.get("unit_cost");
  const per = props.get("per");
  if (
    props.size !== 3 ||
    !Array.isArray(caps) ||
    caps.length === 0 ||
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    typeof per !== "string" ||
    per === ""
  ) {
    say(
      `LISTING_PRICE is ${JSON.stringify(Object.fromEntries(props))} — exactly { capabilities: non-empty string[], unit_cost: finite number ≥ 0, per: non-empty string }`,
    );
    return null;
  }
  const rule = await runnerRule();
  if (typeof rule === "string") {
    violations.push(rule);
    return null;
  }
  let entries: ListingEntry[];
  try {
    entries = rule({ capabilities: caps, unit_cost: cost, per }, undefined);
  } catch (err) {
    say(`the runner refuses LISTING_PRICE (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  return {
    amount: entries[0]!.unit_cost as number,
    per: entries[0]!.per as string,
    source: `${rel} LISTING_PRICE`,
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

/** The operator override the runner alone reads (packages/molecule-runner/src/listing-price.ts). */
export const OVERRIDE_KEY = "MOTEBIT_UNIT_COST";

/** Is `e` `process.env` (also `process["env"]`, `globalThis.process.env`)? */
function isProcessEnv(e: ts.Expression): boolean {
  e = unwrap(e);
  const key = ts.isPropertyAccessExpression(e)
    ? e.name.text
    : ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)
      ? e.argumentExpression.text
      : null;
  if (key !== "env") return false;
  const obj = unwrap((e as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression);
  return (
    (ts.isIdentifier(obj) && obj.text === "process") ||
    (ts.isPropertyAccessExpression(obj) &&
      obj.name.text === "process" &&
      ts.isIdentifier(obj.expression) &&
      obj.expression.text === "globalThis")
  );
}

/** Is `e` `process.env` or one of its members — an assignment target that writes the env? */
function targetsEnv(e: ts.Expression): boolean {
  e = unwrap(e);
  return (
    isProcessEnv(e) ||
    ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) &&
      isProcessEnv(e.expression))
  );
}

/** `Object.*` / `Reflect.*` calls that mutate their first argument. */
const MUTATORS: Record<string, readonly string[]> = {
  Object: ["assign", "defineProperty", "defineProperties", "setPrototypeOf"],
  Reflect: ["set", "defineProperty", "deleteProperty", "setPrototypeOf"],
};

/** How `n` writes process.env, or null when it does not. */
function envWrite(sf: ts.SourceFile, n: ts.Node): string | null {
  if (
    ts.isBinaryExpression(n) &&
    n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    targetsEnv(n.left)
  )
    return `\`${n.left.getText(sf)} ${n.operatorToken.getText(sf)} …\``;
  if (
    (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
    targetsEnv(n.operand)
  )
    return `\`${n.getText(sf)}\``;
  if (ts.isDeleteExpression(n) && targetsEnv(n.expression)) return `\`${n.getText(sf)}\``;
  if (ts.isCallExpression(n) && n.arguments[0] != null && isProcessEnv(n.arguments[0])) {
    const c = unwrap(n.expression);
    if (
      ts.isPropertyAccessExpression(c) &&
      ts.isIdentifier(c.expression) &&
      (MUTATORS[c.expression.text] ?? []).includes(c.name.text)
    )
      return `\`${c.getText(sf)}(${n.arguments[0].getText(sf)}, …)\``;
  }
  return null;
}

/**
 * EVERY service (market or not), every non-test source under src/: names
 * MOTEBIT_UNIT_COST nowhere in code — identifier, property key, string or
 * template literal (comments are not code) — and never writes process.env.
 * Cold review R6 (2026-10-05): `process.env["MOTEBIT_UNIT_COST"] ??= "0.30"`
 * at the top of main() kept this gate green while the service listed $0.30
 * against the $0.25 its pricing.ts and docs state — a coded default smuggled
 * in through the environment. The runner is the variable's only reader; the
 * environment is the operator's input, never a service's output. Deliberate
 * obfuscation (computed keys, strings built at runtime, an aliased env object)
 * is outside the threat model (accidental drift).
 */
export function checkEnvDiscipline(root: string, name: string, violations: string[]): void {
  for (const f of listSourceFiles(join(root, "services", name, "src"))) {
    const sf = parse(f);
    const at = (n: ts.Node) => `${relative(root, f)}:${lineOf(sf, n)}`;
    walk(sf, (n) => {
      const text =
        ts.isIdentifier(n) ||
        ts.isPrivateIdentifier(n) ||
        ts.isStringLiteralLike(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n)
          ? n.text
          : null;
      if (text?.includes(OVERRIDE_KEY))
        violations.push(
          `${at(n)}: names ${OVERRIDE_KEY} — a service's code never names it; the runner alone reads and validates it (${RUNNER_RULE}), and the service's default is the literal LISTING_PRICE in ${PRICING}`,
        );
      const w = envWrite(sf, n);
      if (w != null)
        violations.push(
          `${at(n)}: writes process.env (${w}) — a service never writes the environment (a write there is a default no doc or gate sees); pass the value as an argument or config field, or set it in .env.example / the deployment`,
        );
    });
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
    checkEnvDiscipline(root, name, violations);
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
      invariant: `check-service-truth: ${r.violations.length} service-inventory drift(s) — a doc disagrees with the service's metadata or coded price, or a service's code names MOTEBIT_UNIT_COST / writes process.env`,
      sites: r.violations,
      canonical:
        "role/identity/market: the `motebit` block in services/<name>/package.json; price: the literal `LISTING_PRICE = { capabilities, unit_cost, per }` in services/<name>/src/pricing.ts (data — it cannot read the environment), which main() must pass runMolecule as exactly `pricing: LISTING_PRICE`; the runner alone reads MOTEBIT_UNIT_COST — no service source names it or writes process.env — and applies it (packages/molecule-runner/src/listing-price.ts, refusing a malformed value) and refuses a listing that brings its own price",
      fix: "correct README.md § Architecture and apps/docs/content/docs/operator/architecture.mdx (tree + § Services table + counts) to match the canonical source — the coded default wins, docs conform. A market service: keep its price in src/pricing.ts as `export const LISTING_PRICE: ListingPriceSpec = { capabilities: [...], unit_cost: <number>, per: <unit string> }` — literals only, no env reads (the runner applies MOTEBIT_UNIT_COST) — and call runMolecule once in src/index.ts with `pricing: LISTING_PRICE` after any spread, naming LISTING_PRICE nowhere else; never put `pricing` in getServiceListing. .env.example states the coded default. A service source that names MOTEBIT_UNIT_COST or writes process.env: delete it — change the default in src/pricing.ts (and the docs), set an operator override in the deployment, and pass any other value as an argument or config field; tests (src/**/__tests__, *.test.*) may set env. A new service: add its `motebit` block, then name it once in each inventory. Re-run `pnpm check-service-truth`.",
      doctrine: "docs/drift-defenses.md (#173)",
    });
  }
  const market = r.services.filter((s) => s.market).length;
  console.log(
    `✓ check-service-truth: ${r.services.length} services' metadata + coded listing prices (${market} market listings) agree with ${r.placements} placement(s) and ${r.countClaims} count claim(s) in ${README_PATH} § Architecture and ${ARCHITECTURE_PATH} (tree + § Services). Aperture: proves these two docs and each .env.example match services/*/package.json and each market service's ${PRICING} LISTING_PRICE, which the TypeScript AST shows is literal data naming no process/globalThis/import.meta/require (it cannot read the environment); proves the runner's ${RUNNER_RULE} lists a spec unaltered, carries a sentinel MOTEBIT_UNIT_COST to every entry, and refuses ${MALFORMED_COSTS.length} malformed overrides (no NaN listing — a bad MOTEBIT_UNIT_COST refuses the boot); proves by TypeScript AST that each market service's ${ENTRY} — the file its Dockerfile CMD / start boots as dist/index.js — calls runMolecule exactly once with \`pricing: LISTING_PRICE\`, the price module imported by that file alone and named nowhere else (the runner lists only config pricing and refuses a getServiceListing carrying its own — molecule-runner listing-pricing.test.ts); market:false services read no MOTEBIT_UNIT_COST, have no pricing.ts and call no runMolecule; and, by TypeScript AST of every non-test source under each of the ${r.services.length} services' src/, no code names MOTEBIT_UNIT_COST (identifier, key, string or template literal) and nothing writes process.env (assignment incl. ??=/||=, ++/--, delete, Object.assign/defineProperty/Reflect.set). Computed keys and strings built at runtime are outside the threat model. Nothing is executed but the runner's zero-import override rule: no server boots, no network, no ports. Threat model: guards ACCIDENTAL drift between documented and coded price/unit/role; it does not cover production MOTEBIT_UNIT_COST overrides or hand-edited deployments — the deployed listing is the one the service POSTs to the relay (signed market:listing token) and the relay serves; read the production price there. Not covered: other docs pages; "identity" is declared metadata, not verified against code.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
