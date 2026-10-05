/**
 * check-service-truth self-test — fixture round-trips, nothing executed.
 *
 * Builds a miniature repo (services/* with `motebit` metadata, a pure
 * `src/pricing.ts` exporting `listingPricing(env)`, and an entry
 * `src/index.ts` whose main() calls `runMolecule` with
 * `pricing: listingPricing(process.env)`; a README `## Architecture` section;
 * an architecture.mdx tree + `## Services` table) that the gate passes, then
 * applies one mutation per drift class and requires RED naming it. Pricing is
 * runner-owned by construction (molecule-runner listing-pricing.test.ts), so
 * the gate reads the price from the pure function and proves the wiring by
 * the TypeScript AST of the runMolecule call site. Finally runs the real gate
 * on the real repo through its CLI — in seconds, booting nothing.
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
  /** Source of services/<name>/src/index.ts — the entry whose call site is checked. */
  src: string;
  /** Source of services/<name>/src/pricing.ts, when the service has one. */
  pricing?: string;
  /** Extra files under services/<name>/src. */
  files?: Record<string, string>;
  /** Extra files under services/<name> (Dockerfile …). */
  dirFiles?: Record<string, string>;
  /** Extra fields merged into package.json (and into its `motebit` block). */
  pkg?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  /** services/<name>/.env.example. */
  envExample?: string;
}

const LISTING = `() => Promise.resolve({ capabilities: ["x"], sla: { max_latency_ms: 1, availability_guarantee: 1 }, description: "d" })`;
const CONFIG = `{ serviceName: "fixture", pricing: listingPricing(process.env) }`;

/** A service entry: main() → runMolecule(config, builder). */
const entry = (config = CONFIG, prelude = "", after = "") =>
  `import { runMolecule } from "@motebit/molecule-runner";\n` +
  `import { listingPricing } from "./pricing.js";\n` +
  prelude +
  `async function main(): Promise<void> {\n` +
  `  await runMolecule(${config} as never, () => ({ toolRegistry: {}, getServiceListing: ${LISTING} }) as never);\n` +
  after +
  `}\n` +
  `main().catch((err: unknown) => { console.error(String(err)); process.exit(1); });\n`;

const ENTRY = entry();

const pricingModule = (amount: string, per: string, costExpr = "unitCost") =>
  `export function listingPricing(env: Readonly<Record<string, string | undefined>>) {\n` +
  `  const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "${amount}");\n` +
  `  return [{ capability: "x", unit_cost: ${costExpr}, currency: "USD", per: "${per}" }];\n` +
  `}\n`;

const priced = (amount: string, per: string): Pick<Svc, "src" | "pricing"> => ({
  src: ENTRY,
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
    const src = join(root, "services", name, "src");
    mkdirSync(src, { recursive: true });
    const pkg: Record<string, unknown> = { name: `@motebit/${name}`, type: "module", ...s?.pkg };
    if (s != null)
      pkg["motebit"] = { role: s.role, identity: s.identity, market: s.market, ...s.meta };
    writeFileSync(join(root, "services", name, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(src, "index.ts"), s?.src ?? "export {};\n");
    if (s?.pricing != null) writeFileSync(join(src, "pricing.ts"), s.pricing);
    for (const [f, body] of Object.entries(s?.files ?? {})) writeFileSync(join(src, f), body);
    for (const [f, body] of Object.entries(s?.dirFiles ?? {}))
      writeFileSync(join(root, "services", name, f), body);
    if (s?.envExample != null)
      writeFileSync(join(root, "services", name, ".env.example"), s.envExample);
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

const violations = async (opts: Parameters<typeof fixture>[0]) =>
  (await evaluate(fixture(opts))).violations.join("\n");

/** Violations with `research` patched. */
const research = (patch: Partial<Svc>) => {
  const s = baseServices();
  s["research"] = { ...s["research"]!, ...patch };
  return violations({ services: s });
};

const SITE = "services/research/src/index.ts";

describe("check-service-truth", () => {
  it("is silent on a consistent fixture, and reads the price from the pure listingPricing({})", async () => {
    const r = await evaluate(fixture({}));
    expect(r.violations).toEqual([]);
    expect(r.placements).toBe(12);
    expect(r.countClaims).toBeGreaterThanOrEqual(8);
    expect(r.services.find((s) => s.name === "research")!.price).toEqual({
      amount: 0.25,
      per: "task",
      source: "services/research/src/pricing.ts listingPricing({})",
    });
  });

  it("bites on a wrong role in the README bullets", async () => {
    const readme = swap(README, "- **Molecules** — `research`", "- **Atoms** — `research`");
    expect(await violations({ readme })).toMatch(
      /`research` is listed as atom but services\/research\/package\.json motebit\.role is molecule/,
    );
  });

  it("bites on a wrong role in the tree", async () => {
    const arch = swap(
      ARCH,
      "embed/                 [infrastructure]",
      "embed/                 [atom]",
    );
    expect(await violations({ arch })).toMatch(/`embed` is listed as atom/);
  });

  it("bites on a wrong price (README and table) and a wrong unit (tree)", async () => {
    const readme = swap(README, "($0.25/task, Claude)", "($0.05/task, Claude)");
    expect(await violations({ readme })).toMatch(
      /`research` states \$0\.05\/task but services\/research\/src\/pricing\.ts listingPricing\(\{\}\) lists \$0\.25\/task/,
    );
    const arch = swap(ARCH, "$0.25/task. Claude.", "$0.25/report. Claude.");
    expect(await violations({ arch })).toMatch(/states \$0\.25\/report/);
  });

  it("bites when an unpriced service is given a price, or a priced one is called unpriced", async () => {
    const arch = swap(ARCH, "`read-url` (unpriced)", "`read-url` ($0.002/request)");
    expect(await violations({ arch })).toMatch(/`read-url` must say "unpriced"/);
    const readme = swap(README, "($0.25/task, Claude)", "(unpriced)");
    expect(await violations({ readme })).toMatch(/`research` states no price/);
  });

  it("bites when a non-market service carries a price", async () => {
    const readme = swap(README, "`embed` (no identity", "`embed` ($0.01/request, no identity");
    expect(await violations({ readme })).toMatch(
      /`embed` states \$0\.01\/request but the service does not list/,
    );
  });

  it("bites on a missing service in each inventory", async () => {
    const readme = swap(
      README,
      "- **Infrastructure** — `embed` (no identity, no MCP listing)\n",
      "",
    );
    expect(await violations({ readme })).toMatch(
      /README\.md .*service `embed` \(infrastructure\) is not named/,
    );
    const arch = swap(
      ARCH,
      "│   ├── read-url/              [atom]        Unpriced. Reads URLs.\n",
      "",
    );
    expect(await violations({ arch })).toMatch(
      /services\/ tree\): service `read-url` \(atom\) is not named/,
    );
  });

  it("bites on a duplicate service", async () => {
    const arch = swap(ARCH, "| `embed`                 |", "| `embed`, `relay`        |");
    expect(await violations({ arch })).toMatch(/service `relay` is named 2 times/);
  });

  it("bites on missing metadata and on an invalid role", async () => {
    const s = baseServices() as Record<string, Svc | null>;
    s["embed"] = null;
    expect(await violations({ services: s })).toMatch(
      /services\/embed\/package\.json: missing the `motebit` service metadata block/,
    );
    const t = baseServices();
    t["embed"] = { ...t["embed"]!, role: "glue" };
    expect(await violations({ services: t })).toMatch(/motebit\.role "glue" is not one of/);
  });

  it("bites on a count mismatch (digits and number words)", async () => {
    const readme = swap(README, "1 atom provider", "2 atom providers");
    expect(await violations({ readme })).toMatch(
      /count claim "2 atom providers" — the metadata derives 1 atom/,
    );
    const arch = swap(ARCH, "Four services in four roles.", "Five services in four roles.");
    expect(await violations({ arch })).toMatch(
      /count claim "Five services in" — the metadata derives 4 services/,
    );
    const r2 = swap(README, "2 list on the market", "3 list on the market");
    expect(await violations({ readme: r2 })).toMatch(/derives 2 market/);
  });

  it("refuses the retired role label 'glue'", async () => {
    const readme = swap(README, "- **Infrastructure** —", "- **Glue** —");
    const v = await violations({ readme });
    expect(v).toMatch(/the role "glue" is retired/);
    expect(v).toMatch(/unrecognised role label/);
  });

  it("a price change in pricing.ts is RED against the docs (the coded default wins)", async () => {
    const v = await research({ pricing: pricingModule("0.30", "task") });
    expect(v).toMatch(
      /`research` states \$0\.25\/task but services\/research\/src\/pricing\.ts listingPricing\(\{\}\) lists \$0\.3\/task/,
    );
    expect(await research({ pricing: pricingModule("0.25", "report") })).toMatch(
      /lists \$0\.25\/report/,
    );
  });

  it("a market:true service whose runMolecule config carries no pricing is RED", async () => {
    expect(await research({ src: entry(`{ serviceName: "fixture" }`) })).toMatch(
      new RegExp(`${SITE}: line \\d+: runMolecule's config has 0 \`pricing\` properties`),
    );
    // No runMolecule call at all, or no pricing.ts at all.
    expect(await research({ src: "export {};\n" })).toMatch(
      /no `import \{ runMolecule \} from "@motebit\/molecule-runner"`/,
    );
    const s = baseServices();
    delete s["research"]!.pricing;
    expect(await violations({ services: s })).toMatch(
      /services\/research: motebit\.market is true but there is no src\/pricing\.ts/,
    );
  });

  it("config pricing must be exactly listingPricing(process.env)", async () => {
    for (const expr of [
      "listingPricing({})",
      'listingPricing({ ...process.env, MOTEBIT_UNIT_COST: "0.01" })',
      '[{ capability: "x", unit_cost: 0.25, currency: "USD", per: "task" }]',
      'listingPricing(process.env).map((p) => ({ ...p, per: "page" }))',
    ])
      expect(
        await research({ src: entry(`{ serviceName: "f", pricing: ${expr} }`) }),
        expr,
      ).toMatch(/runMolecule's `pricing` must be exactly `listingPricing\(process\.env\)`/);
    expect(
      await research({ src: entry(`{ pricing: listingPricing(process.env), pricing: [] }`) }),
    ).toMatch(/has 2 `pricing` properties/);
    // A config built elsewhere cannot be checked: it must be the literal.
    expect(
      await research({
        src: entry("cfg", "const cfg = { pricing: listingPricing(process.env) };\n"),
      }),
    ).toMatch(/config must be an object literal/);
  });

  it("a spread after pricing could replace it (RED); a spread before it cannot (green)", async () => {
    expect(
      await research({
        src: entry(`{ pricing: listingPricing(process.env), ...extra }`, "const extra = {};\n"),
      }),
    ).toMatch(/a spread after `pricing` in runMolecule's config could replace it/);
    expect(
      await research({
        src: entry(`{ ...extra, pricing: listingPricing(process.env) }`, "const extra = {};\n"),
      }),
    ).toBe("");
  });

  it("one call, one import, no aliases, no re-binding, no other file", async () => {
    expect(
      await research({
        src: entry(CONFIG, "", `  await runMolecule(${CONFIG} as never, () => ({}) as never);\n`),
      }),
    ).toMatch(/`runMolecule` must be referenced exactly once, as a direct call \(found 2 call/);
    expect(await research({ src: entry(CONFIG, "const again = runMolecule;\n") })).toMatch(
      /found 1 call\(s\), 2 reference\(s\)/,
    );
    expect(
      await research({
        src: ENTRY.replace("{ runMolecule }", "{ runMolecule as rm, runMolecule }"),
      }),
    ).toMatch(/`runMolecule` is imported from "@motebit\/molecule-runner" as an alias \(`rm`\)/);
    expect(
      await research({
        src: ENTRY.replace(
          `import { runMolecule } from "@motebit/molecule-runner";`,
          `import * as R from "@motebit/molecule-runner";\nconst { runMolecule } = R;`,
        ),
      }),
    ).toMatch(/`import \* as R from "@motebit\/molecule-runner"`/);
    expect(
      await research({
        src: ENTRY.replace(`"./pricing.js"`, `"./other.js"`),
        files: { "other.ts": "export const listingPricing = () => [];\n" },
      }),
    ).toMatch(/`listingPricing` is imported from "\.\/other\.js"/);
    expect(
      await research({
        src: entry(CONFIG, "", "  const listingPricing = () => [];\n  void listingPricing;\n"),
      }),
    ).toMatch(/re-binds `listingPricing`/);
    expect(await research({ src: entry(CONFIG, "const process = { env: {} };\n") })).toMatch(
      /re-binds `process`/,
    );
    expect(
      await research({
        files: {
          "boot.ts": `import { runMolecule } from "@motebit/molecule-runner";\nvoid runMolecule;\n`,
        },
      }),
    ).toMatch(/services\/research\/src\/boot\.ts:\d+: names `runMolecule`/);
  });

  it("pricing.ts must be pure by shape — the gate imports it, so nothing may run at load", async () => {
    expect(
      await research({
        pricing: `import { readFileSync } from "node:fs";\n` + pricingModule("0.25", "task"),
      }),
    ).toMatch(
      /src\/pricing\.ts: line 1: .* type-only imports, types and function declarations only/,
    );
    expect(
      await research({ pricing: `console.log("boot");\n` + pricingModule("0.25", "task") }),
    ).toMatch(/line 1: `console\.log\("boot"\);`/);
    expect(
      await research({
        pricing:
          `import type { X } from "./x.js";\nexport type { X };\n` + pricingModule("0.25", "task"),
      }),
    ).toBe("");
  });

  it("the override reaches every entry unaltered: arithmetic and hardcodes are RED", async () => {
    expect(await research({ pricing: pricingModule("0.25", "task", "unitCost * 2") })).toMatch(
      /with MOTEBIT_UNIT_COST="0\.123457" lists unit_costs \[0\.246914\]/,
    );
    // A hardcoded unit_cost equal to the docs: green on the default, deaf to the env.
    expect(await research({ pricing: pricingModule("0.25", "task", "0.25") })).toMatch(
      /lists unit_costs \[0\.25\] — every entry's unit_cost must be the parsed override/,
    );
  });

  it("refuses an empty, malformed, multi-price or impure listing", async () => {
    const fn = (body: string) =>
      `export function listingPricing(env: Record<string, string | undefined>) {\n  void env;\n  ${body}\n}\n`;
    expect(await research({ pricing: fn("return [];") })).toMatch(
      /listingPricing\(\{\}\) lists no pricing/,
    );
    expect(
      await research({
        pricing: fn(
          `return [{ capability: "x", unit_cost: "0.25", currency: "USD", per: "task" }];`,
        ),
      }),
    ).toMatch(/is not \{ capability: string, unit_cost: finite ≥ 0/);
    expect(
      await research({
        pricing: fn(
          `const c = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0.25"); return [{ capability: "x", unit_cost: c, currency: "USD", per: "task" }, { capability: "y", unit_cost: c, currency: "USD", per: "page" }];`,
        ),
      }),
    ).toMatch(/lists 2 different `per` units/);
    expect(await research({ pricing: fn(`throw new Error("nope");`) })).toMatch(
      /listingPricing\(\{\}\) threw \(nope\)/,
    );
  });

  it("ties market:false to no price, no pricing.ts and no runMolecule", async () => {
    const s = baseServices();
    s["embed"] = { ...s["embed"]!, src: `const c = process.env["MOTEBIT_UNIT_COST"];\nvoid c;\n` };
    expect(await violations({ services: s })).toMatch(
      /services\/embed: motebit\.market is false but services\/embed\/src\/index\.ts reads MOTEBIT_UNIT_COST/,
    );
    const t = baseServices();
    t["embed"] = {
      ...t["embed"]!,
      src: entry(`{ serviceName: "e" }`),
      pricing: pricingModule("0", "x"),
    };
    const v = await violations({ services: t });
    expect(v).toMatch(/services\/embed: motebit\.market is false but src\/pricing\.ts exists/);
    expect(v).toMatch(
      /services\/embed: motebit\.market is false but services\/embed\/src\/index\.ts:\d+ calls runMolecule/,
    );
    const u = baseServices();
    u["research"] = { ...u["research"]!, identity: false };
    expect(await violations({ services: u })).toMatch(/only a service with an identity can list/);
  });

  it("the checked entry is the one the deploy boots; listingProbeEnv is retired", async () => {
    expect(
      await research({
        dirFiles: { Dockerfile: `FROM node\nCMD ["node", "dist/index.js"]\n` },
        pkg: { scripts: { start: "node dist/index.js" } },
      }),
    ).toBe("");
    expect(
      await research({ dirFiles: { Dockerfile: `FROM node\nCMD ["node", "dist/server.js"]\n` } }),
    ).toMatch(
      /services\/research\/Dockerfile: must boot exactly `CMD \["node", "dist\/index\.js"\]`/,
    );
    expect(await research({ pkg: { scripts: { start: "node dist/server.js" } } })).toMatch(
      /services\/research\/package\.json: scripts\.start is "node dist\/server\.js"/,
    );
    expect(await research({ meta: { listingProbeEnv: {} } })).toMatch(
      /motebit\.listingProbeEnv is retired/,
    );
  });

  it(".env.example must state the coded default (value and comment)", async () => {
    expect(
      await research({ envExample: "# Price per task (default: 0.25)\nMOTEBIT_UNIT_COST=0.25\n" }),
    ).toBe("");
    expect(await research({ envExample: "# Listed price\nMOTEBIT_UNIT_COST=0.05\n" })).toMatch(
      /services\/research\/\.env\.example:2: MOTEBIT_UNIT_COST=0\.05 but services\/research\/src\/pricing\.ts listingPricing\(\{\}\) lists \$0\.25\/task by default/,
    );
    expect(
      await research({ envExample: "# Price (default: 0.50)\n# MOTEBIT_UNIT_COST=0.25\n" }),
    ).toMatch(/\.env\.example:2: "default: 0\.50" \(line 1\) but/);
    const s = baseServices();
    s["embed"] = { ...s["embed"]!, envExample: "MOTEBIT_UNIT_COST=0\n" };
    expect(await violations({ services: s })).toMatch(
      /services\/embed\/\.env\.example:1: MOTEBIT_UNIT_COST on a service whose motebit\.market is false/,
    );
  });

  it("the real repo passes through the CLI in seconds, booting nothing, with an aperture line", async () => {
    const t0 = Date.now();
    const r = spawnSync("npx", ["tsx", join(ROOT, "scripts/check-service-truth.ts")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Aperture: proves these two docs and each \.env\.example match/);
    expect(r.stdout).toMatch(/no server boots, no network, no ports/);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 60_000);
});
