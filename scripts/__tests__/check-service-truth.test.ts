/**
 * check-service-truth self-test — fixture round-trips.
 *
 * Builds a miniature repo (services/* with `motebit` metadata, a pure
 * `src/pricing.ts` `listingPricing(env)` per listing service and an index that
 * lists exactly `pricing: listingPricing(process.env)`, a README `## Architecture` section, an
 * architecture.mdx tree + `## Services` table) that the gate passes, then
 * applies one mutation per drift class and requires RED naming it: wrong role,
 * wrong price, wrong unit, missing service, duplicate service, missing
 * metadata, count mismatch, retired "glue", market flag vs code, and the
 * listed-price bypasses a cold review found (P1: arithmetic on the env read;
 * P2: a hardcoded listing `unit_cost`) in every place they can be written. Finally runs
 * the real gate on the real repo through its CLI.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, ARCHITECTURE_PATH } from "../check-service-truth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

interface Svc {
  role: string;
  identity: boolean;
  market: boolean;
  /** Source of services/<name>/src/index.ts. */
  src: string;
  /** Source of services/<name>/src/pricing.ts, when the service has one. */
  pricing?: string;
}

/** The listing site main() carries: exactly `pricing: listingPricing(process.env)`. */
const LISTING =
  `import { listingPricing } from "./pricing.js";\n` +
  `export const listing = { capabilities: ["x"], pricing: listingPricing(process.env) };\n`;

const pricingModule = (amount: string, per: string, costExpr = "unitCost") =>
  `export function listingPricing(env: Readonly<Record<string, string | undefined>>) {\n` +
  `  const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "${amount}");\n` +
  `  return [{ capability: "x", unit_cost: ${costExpr}, currency: "USD", per: "${per}" }];\n` +
  `}\n`;

const priced = (amount: string, per: string): Pick<Svc, "src" | "pricing"> => ({
  src: LISTING,
  pricing: pricingModule(amount, per),
});

function baseServices(): Record<string, Svc> {
  return {
    relay: { role: "relay", identity: true, market: false, src: "export {};\n" },
    research: { role: "molecule", identity: true, market: true, ...priced("0.25", "task") },
    "read-url": { role: "atom", identity: true, market: true, ...priced("0", "request") },
    embed: { role: "infrastructure", identity: false, market: false, src: "export {};\n" },
  };
}

const README = `# Fixture

## Architecture

**1 relay + 1 molecule agent + 1 atom provider + 1 infrastructure service; 2 list on the market.**

**Marketplace** — 4 services in four roles:

- **The relay** — \`relay\` (sync, settlement)
- **Molecules** — \`research\` ($0.25/task, Claude)
- **Atoms** — \`read-url\` (unpriced — $0 by default)
- **Infrastructure** — \`embed\` (no identity, no MCP listing)

**Protocol** — specs.
`;

const ARCH = `# Architecture

\`\`\`
motebit/
├── services/
│   ├── relay/                 [relay]       Sync.
│   ├── research/              [molecule]    $0.25/task. Claude.
│   ├── read-url/              [atom]        Unpriced. Reads URLs.
│   └── embed/                 [infrastructure] ONNX embedding service.
│
├── spec/
\`\`\`

## Services

Four services in four roles.

| Role                | Services                  | Pattern |
| ------------------- | ------------------------- | ------- |
| **Relay**           | \`relay\`                 | Sync.   |
| **Molecules**       | \`research\` ($0.25/task) | Reason. |
| **Atoms**           | \`read-url\` (unpriced)   | Read.   |
| **Infrastructure**  | \`embed\`                 | Embed.  |

## Specifications
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(opts: {
  services?: Record<string, Svc | null>;
  readme?: string;
  arch?: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), "st-service-truth-"));
  dirs.push(root);
  const services = opts.services ?? baseServices();
  for (const [name, s] of Object.entries(services)) {
    mkdirSync(join(root, "services", name, "src"), { recursive: true });
    const pkg: Record<string, unknown> = { name: `@motebit/${name}` };
    if (s != null) pkg["motebit"] = { role: s.role, identity: s.identity, market: s.market };
    writeFileSync(join(root, "services", name, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(root, "services", name, "src", "index.ts"), s?.src ?? "export {};\n");
    if (s?.pricing != null)
      writeFileSync(join(root, "services", name, "src", "pricing.ts"), s.pricing);
  }
  writeFileSync(join(root, "README.md"), opts.readme ?? README);
  mkdirSync(dirname(join(root, ARCHITECTURE_PATH)), { recursive: true });
  writeFileSync(join(root, ARCHITECTURE_PATH), opts.arch ?? ARCH);
  return root;
}

function swap(text: string, from: string, to: string): string {
  expect(text.split(from).length, `exactly one "${from}"`).toBe(2);
  return text.replace(from, to);
}

describe("check-service-truth", () => {
  it("is silent on a consistent fixture", () => {
    const r = evaluate(fixture({}));
    expect(r.violations).toEqual([]);
    expect(r.placements).toBe(12);
    expect(r.countClaims).toBeGreaterThanOrEqual(8);
  });

  it("bites on a wrong role in the README bullets", () => {
    const readme = swap(README, "- **Molecules** — `research`", "- **Atoms** — `research`");
    const v = evaluate(fixture({ readme })).violations.join("\n");
    expect(v).toMatch(
      /`research` is listed as atom but services\/research\/package\.json motebit\.role is molecule/,
    );
  });

  it("bites on a wrong role in the tree", () => {
    const arch = swap(
      ARCH,
      "embed/                 [infrastructure]",
      "embed/                 [atom]",
    );
    expect(evaluate(fixture({ arch })).violations.join("\n")).toMatch(/`embed` is listed as atom/);
  });

  it("bites on a wrong price (README and table) and a wrong unit (tree)", () => {
    const readme = swap(README, "($0.25/task, Claude)", "($0.05/task, Claude)");
    const v1 = evaluate(fixture({ readme })).violations.join("\n");
    expect(v1).toMatch(
      /`research` states \$0\.05\/task but services\/research\/src\/pricing\.ts codes \$0\.25\/task/,
    );
    const arch = swap(ARCH, "$0.25/task. Claude.", "$0.25/report. Claude.");
    expect(evaluate(fixture({ arch })).violations.join("\n")).toMatch(/states \$0\.25\/report/);
  });

  it("bites when an unpriced service is given a price, or a priced one is called unpriced", () => {
    const arch = swap(ARCH, "`read-url` (unpriced)", "`read-url` ($0.002/request)");
    expect(evaluate(fixture({ arch })).violations.join("\n")).toMatch(
      /`read-url` must say "unpriced"/,
    );
    const readme = swap(README, "($0.25/task, Claude)", "(unpriced)");
    expect(evaluate(fixture({ readme })).violations.join("\n")).toMatch(
      /`research` states no price/,
    );
  });

  it("bites when a non-market service carries a price", () => {
    const readme = swap(README, "`embed` (no identity", "`embed` ($0.01/request, no identity");
    expect(evaluate(fixture({ readme })).violations.join("\n")).toMatch(
      /`embed` states \$0\.01\/request but the service does not list/,
    );
  });

  it("bites on a missing service in each inventory", () => {
    const readme = swap(
      README,
      "- **Infrastructure** — `embed` (no identity, no MCP listing)\n",
      "",
    );
    expect(evaluate(fixture({ readme })).violations.join("\n")).toMatch(
      /README\.md .*service `embed` \(infrastructure\) is not named/,
    );
    const arch = swap(
      ARCH,
      "│   ├── read-url/              [atom]        Unpriced. Reads URLs.\n",
      "",
    );
    expect(evaluate(fixture({ arch })).violations.join("\n")).toMatch(
      /services\/ tree\): service `read-url` \(atom\) is not named/,
    );
  });

  it("bites on a duplicate service", () => {
    const arch = swap(ARCH, "| `embed`                 |", "| `embed`, `relay`        |");
    expect(evaluate(fixture({ arch })).violations.join("\n")).toMatch(
      /service `relay` is named 2 times/,
    );
  });

  it("bites on missing metadata and on an invalid role", () => {
    const s = baseServices() as Record<string, Svc | null>;
    s["embed"] = null;
    expect(evaluate(fixture({ services: s })).violations.join("\n")).toMatch(
      /services\/embed\/package\.json: missing the `motebit` service metadata block/,
    );
    const t = baseServices();
    t["embed"] = { ...t["embed"]!, role: "glue" };
    expect(evaluate(fixture({ services: t })).violations.join("\n")).toMatch(
      /motebit\.role "glue" is not one of/,
    );
  });

  it("bites on a count mismatch (digits and number words)", () => {
    const readme = swap(README, "1 atom provider", "2 atom providers");
    expect(evaluate(fixture({ readme })).violations.join("\n")).toMatch(
      /count claim "2 atom providers" — the metadata derives 1 atom/,
    );
    const arch = swap(ARCH, "Four services in four roles.", "Five services in four roles.");
    expect(evaluate(fixture({ arch })).violations.join("\n")).toMatch(
      /count claim "Five services in" — the metadata derives 4 services/,
    );
    const r2 = swap(README, "2 list on the market", "3 list on the market");
    expect(evaluate(fixture({ readme: r2 })).violations.join("\n")).toMatch(/derives 2 market/);
  });

  it("refuses the retired role label 'glue'", () => {
    const readme = swap(README, "- **Infrastructure** —", "- **Glue** —");
    const v = evaluate(fixture({ readme })).violations.join("\n");
    expect(v).toMatch(/the role "glue" is retired/);
    expect(v).toMatch(/unrecognised role label/);
  });

  it("ties the market flag to the code that lists", () => {
    const s = baseServices();
    s["embed"] = { ...s["embed"]!, ...priced("0.01", "request") };
    expect(evaluate(fixture({ services: s })).violations.join("\n")).toMatch(
      /services\/embed: motebit\.market is false but services\/embed\/src\/pricing\.ts codes a MOTEBIT_UNIT_COST price/,
    );
    const s2 = baseServices();
    s2["embed"] = { ...s2["embed"]!, src: `export const c = process.env.MOTEBIT_UNIT_COST;\n` };
    expect(evaluate(fixture({ services: s2 })).violations.join("\n")).toMatch(
      /services\/embed: motebit\.market is false but services\/embed\/src\/index\.ts:1 codes/,
    );
    const t = baseServices();
    t["research"] = { ...t["research"]!, src: "export {};\n", pricing: undefined };
    expect(evaluate(fixture({ services: t })).violations.join("\n")).toMatch(
      /services\/research: motebit\.market is true but there is no pricing\.ts/,
    );
    const u = baseServices();
    u["research"] = { ...u["research"]!, identity: false };
    expect(evaluate(fixture({ services: u })).violations.join("\n")).toMatch(
      /only a service with an identity can list/,
    );
  });

  it("refuses a pricing module that does not execute purely, or lists a bad entry", () => {
    const bad = (pricing: string) => {
      const s = baseServices();
      s["research"] = { ...s["research"]!, pricing };
      return evaluate(fixture({ services: s })).violations.join("\n");
    };
    // An unresolvable default (was: `?? DEFAULT`) — throws when executed.
    expect(bad(pricingModule("0.25", "task").replace('?? "0.25"', "?? DEFAULT"))).toMatch(
      /research\/src\/pricing\.ts: did not execute purely \(DEFAULT is not defined\)/,
    );
    // Reading the real process env instead of the injected one.
    expect(bad(pricingModule("0.25", "task").replace('env["', 'process.env["'))).toMatch(
      /did not execute purely \(process is not defined\)/,
    );
    // Importing anything.
    expect(
      bad(
        `import { readFileSync } from "node:fs";\n` +
          pricingModule("0.25", "task", "readFileSync.length"),
      ),
    ).toMatch(/did not execute purely \(require is not defined\)/);
    // No export / a negative price / non-USD.
    expect(bad(`export const x = 1;\n`)).toMatch(/exports no `listingPricing` function/);
    expect(bad(pricingModule("-1", "task"))).toMatch(/lists an entry that is not \{ capability/);
    expect(bad(pricingModule("0.25", "task").replace('"USD"', '"EUR"'))).toMatch(
      /lists an entry that is not/,
    );
  });

  // ── the cold-review bypasses: the price the service LISTS, not a literal ──

  it("P1: arithmetic on the price — in pricing.ts, on the listing, or the original env-read shape", () => {
    const run = (patch: Partial<Svc>) => {
      const s = baseServices();
      s["research"] = { ...s["research"]!, ...patch };
      return evaluate(fixture({ services: s })).violations.join("\n");
    };
    // In the pricing module: the executed default is $0.5, the docs say $0.25.
    const v1 = run({ pricing: pricingModule("0.25", "task").replace('"0.25");', '"0.25") * 2;') });
    expect(v1).toMatch(
      /`research` states \$0\.25\/task but services\/research\/src\/pricing\.ts codes \$0\.5\/task/,
    );
    expect(v1).toMatch(/with MOTEBIT_UNIT_COST="0\.123457", listingPricing lists \[0\.246914\]/);
    // On the listing in main()'s file.
    const v2 = run({
      src: LISTING.replace(
        "listingPricing(process.env)",
        "listingPricing(process.env).map((p) => ({ ...p, unit_cost: p.unit_cost * 2 }))",
      ),
    });
    expect(v2).toMatch(
      /`unit_cost` appears outside services\/research\/src\/pricing\.ts \(services\/research\/src\/index\.ts:2\)/,
    );
    expect(v2).toMatch(/a `pricing` value other than `listingPricing\(process\.env\)`/);
    // The original shape: `parseFloat(process.env[...] ?? "0.25") * 2` beside the listing.
    const v3 = run({
      src:
        `const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.25") * 2;\n` +
        `export const listing = { pricing: [{ capability: "x", unit_cost: unitCost, currency: "USD", per: "task" }] };\n`,
    });
    expect(v3).toMatch(
      /MOTEBIT_UNIT_COST is read outside services\/research\/src\/pricing\.ts \(services\/research\/src\/index\.ts:1\)/,
    );
    expect(v3).toMatch(/0 `pricing: listingPricing\(process\.env\)` listing site/);
  });

  it("P2: a hardcoded listing unit_cost — in pricing.ts or in main()'s listing", () => {
    const run = (patch: Partial<Svc>) => {
      const s = baseServices();
      s["research"] = { ...s["research"]!, ...patch };
      return evaluate(fixture({ services: s })).violations.join("\n");
    };
    const v1 = run({ pricing: pricingModule("0.25", "task", "0.5") });
    expect(v1).toMatch(
      /states \$0\.25\/task but services\/research\/src\/pricing\.ts codes \$0\.5\/task/,
    );
    expect(v1).toMatch(
      /listingPricing lists \[0\.5\] — every entry's unit_cost must be the parsed override/,
    );
    // Even a hardcode that EQUALS the docs is refused: the override is dead.
    expect(run({ pricing: pricingModule("0.25", "task", "0.25") })).toMatch(
      /listingPricing lists \[0\.25\] — every entry's unit_cost must be the parsed override/,
    );
    const v2 = run({
      src:
        `import { listingPricing } from "./pricing.js";\n` +
        `void listingPricing;\n` +
        `export const listing = { pricing: [{ capability: "x", unit_cost: 0.5, currency: "USD", per: "task" }] };\n`,
    });
    expect(v2).toMatch(
      /`unit_cost` appears outside services\/research\/src\/pricing\.ts \(services\/research\/src\/index\.ts:3\)/,
    );
    expect(v2).toMatch(/a `pricing` value other than/);
  });

  it("refuses a shadowed listingPricing, a missing import and a second listing", () => {
    const run = (src: string) => {
      const s = baseServices();
      s["research"] = { ...s["research"]!, src };
      return evaluate(fixture({ services: s })).violations.join("\n");
    };
    expect(
      run(
        `const listingPricing = (_e: unknown) => [];\n` +
          `export const listing = { pricing: listingPricing(process.env) };\n`,
      ),
    ).toMatch(
      /no source file imports \{ listingPricing \}[\s\S]*`listingPricing` is redeclared outside/,
    );
    expect(
      run(LISTING + `export const again = { pricing: listingPricing(process.env) };\n`),
    ).toMatch(/2 `pricing: listingPricing\(process\.env\)` listing site\(s\)/);
    expect(
      run(LISTING.replace("listingPricing(process.env)", "listingPricing({ ...process.env })")),
    ).toMatch(/a `pricing` value other than `listingPricing\(process\.env\)`/);
  });

  it("the real repo passes through the CLI, with an aperture line", () => {
    const r = spawnSync("npx", ["tsx", join(ROOT, "scripts/check-service-truth.ts")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Aperture: proves these two docs match/);
  });
});
