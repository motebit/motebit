/**
 * check-service-truth self-test — fixture round-trips, nothing executed but
 * the runner's pure override rule.
 *
 * Builds a miniature repo (services/* with `motebit` metadata, a data-only
 * `src/pricing.ts` exporting `LISTING_PRICE = { capabilities, unit_cost, per }`
 * of literals, and an entry `src/index.ts` whose main() calls `runMolecule`
 * with `pricing: LISTING_PRICE`; a README `## Architecture` section; an
 * architecture.mdx tree + `## Services` table) that the gate passes, then
 * applies one mutation per drift class and requires RED naming it. The price
 * module cannot read the environment (R5, 2026-10-05): MOTEBIT_UNIT_COST is
 * read and validated by the runner alone (molecule-runner listing-price.ts),
 * so a second override path, an env-chosen `per`, or a NaN price has nowhere
 * to live. Finally runs the real gate on the real repo through its CLI.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, ARCHITECTURE_PATH, MALFORMED_COSTS } from "../check-service-truth.js";

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
const CONFIG = `{ serviceName: "fixture", pricing: LISTING_PRICE }`;

/** A service entry: main() → runMolecule(config, builder). */
const entry = (config = CONFIG, prelude = "", after = "") =>
  `import { runMolecule } from "@motebit/molecule-runner";\n` +
  `import { LISTING_PRICE } from "./pricing.js";\n` +
  prelude +
  `async function main(): Promise<void> {\n` +
  `  await runMolecule(${config} as never, () => ({ toolRegistry: {}, getServiceListing: ${LISTING} }) as never);\n` +
  after +
  `}\n` +
  `main().catch((err: unknown) => { console.error(String(err)); process.exit(1); });\n`;

const ENTRY = entry();

const pricingModule = (amount: string, per: string, caps = `["x"]`) =>
  `import type { ListingPriceSpec } from "@motebit/molecule-runner";\n\n` +
  `export const LISTING_PRICE: ListingPriceSpec = { capabilities: ${caps}, unit_cost: ${amount}, per: "${per}" };\n`;

/**
 * The PREVIOUS contract (origin/fix/service-truth 3c7ba92): pricing.ts exported
 * `listingPricing(env)` and main() passed `listingPricing(process.env)`. Cold
 * review R5 showed the function could read any other key and stay green.
 */
const envFnService = (body: string): Pick<Svc, "src" | "pricing"> => ({
  src:
    `import { runMolecule } from "@motebit/molecule-runner";\n` +
    `import { listingPricing } from "./pricing.js";\n` +
    `async function main(): Promise<void> {\n` +
    `  await runMolecule({ serviceName: "fixture", pricing: listingPricing(process.env) } as never, () => ({ toolRegistry: {}, getServiceListing: ${LISTING} }) as never);\n` +
    `}\n` +
    `main().catch((err: unknown) => { console.error(String(err)); process.exit(1); });\n`,
  pricing:
    `export function listingPricing(env: Readonly<Record<string, string | undefined>>) {\n` +
    `  ${body}\n` +
    `}\n`,
});

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
  it("is silent on a consistent fixture, and reads the price from the literal LISTING_PRICE", async () => {
    const r = await evaluate(fixture({}));
    expect(r.violations).toEqual([]);
    expect(r.placements).toBe(12);
    expect(r.countClaims).toBeGreaterThanOrEqual(8);
    expect(r.services.find((s) => s.name === "research")!.price).toEqual({
      amount: 0.25,
      per: "task",
      source: "services/research/src/pricing.ts LISTING_PRICE",
    });
  });

  // Cold review R5 (2026-10-05): under the previous contract each of these
  // stayed GREEN — the gate only called listingPricing with {} and a sentinel,
  // so any other key was never exercised. The seam is removed, not probed:
  // pricing.ts can no longer read the environment at all.
  describe("R5: the price module cannot read the environment", () => {
    const PRICE_MODULE = /services\/research\/src\/pricing\.ts: /;
    it("a second, invisible override key is RED", async () => {
      const v = await research(
        envFnService(
          `const unitCost = parseFloat(env["MOTEBIT_AUDITOR_COST"] ?? env["MOTEBIT_UNIT_COST"] ?? "0.25");\n` +
            `  return [{ capability: "x", unit_cost: unitCost, currency: "USD", per: "task" }];`,
        ),
      );
      expect(v).toMatch(PRICE_MODULE);
      expect(v).toMatch(/holds type-only imports, types and ONE `export const LISTING_PRICE/);
    });
    it("an env-chosen `per` is RED", async () => {
      const v = await research(
        envFnService(
          `const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0.25");\n` +
            `  return [{ capability: "x", unit_cost: unitCost, currency: "USD", per: env["MOTEBIT_PER"] ?? "task" }];`,
        ),
      );
      expect(v).toMatch(PRICE_MODULE);
    });
    it("a process.env read inside the price module is RED (also in data-constant shape)", async () => {
      const v = await research(
        envFnService(
          `const unitCost = process.env["PROD"] ? 9 : parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0.25");\n` +
            `  return [{ capability: "x", unit_cost: unitCost, currency: "USD", per: "task" }];`,
        ),
      );
      expect(v).toMatch(PRICE_MODULE);
      expect(v).toMatch(/names `process` — the price module cannot read the environment/);
      for (const [expr, name] of [
        [`process.env["PROD"] ? 9 : 0.25`, "process"],
        [`globalThis.process ? 9 : 0.25`, "globalThis"],
        [`import.meta.env ? 9 : 0.25`, "import.meta"],
      ] as const)
        expect(await research({ pricing: pricingModule(expr, "task") }), expr).toMatch(
          new RegExp(
            `names \`${name.replace(".", "\\.")}\` — the price module cannot read the environment`,
          ),
        );
    });
    it('a module that parses MOTEBIT_UNIT_COST itself ("abc" ⇒ NaN listed) is RED — the runner alone parses it', async () => {
      const v = await research(
        envFnService(
          `const unitCost = parseFloat(env["MOTEBIT_UNIT_COST"] ?? "0.25");\n` +
            `  return [{ capability: "x", unit_cost: unitCost, currency: "USD", per: "task" }];`,
        ),
      );
      expect(v).toMatch(PRICE_MODULE);
      // And the override rule the gate pins refuses it (molecule-runner listing-price.ts).
      expect(v).not.toMatch(/MOTEBIT_UNIT_COST override rule/);
    });
  });

  // Cold review R6 (2026-10-05): `process.env["MOTEBIT_UNIT_COST"] ??= "0.30"`
  // at the top of main() (or in a helper module) stayed GREEN while research
  // listed $0.30 against $0.25 in pricing.ts and the docs — a coded default
  // smuggled in through the environment, the exact accidental pattern origin/main
  // used. Deny by default, for EVERY service: the runner is the variable's only
  // reader, and a service's sources never write process.env.
  describe("R6: no service names MOTEBIT_UNIT_COST or writes process.env", () => {
    const atTop = (stmt: string) =>
      swap(
        ENTRY,
        "async function main(): Promise<void> {\n",
        `async function main(): Promise<void> {\n  ${stmt}\n`,
      );
    const NAMES = (file: string) =>
      new RegExp(`services/research/src/${file}:\\d+: names MOTEBIT_UNIT_COST`);
    const WRITES = (file: string) =>
      new RegExp(`services/research/src/${file}:\\d+: .* — env access is deny-by-default`);

    it("`??=` in index.ts is RED (names the variable and writes the env)", async () => {
      const v = await research({ src: atTop(`process.env["MOTEBIT_UNIT_COST"] ??= "0.30";`) });
      expect(v).toMatch(NAMES("index\\.ts"));
      expect(v).toMatch(WRITES("index\\.ts"));
    });
    it("`??=` in a helper module the entry imports is RED", async () => {
      const v = await research({
        src: entry(CONFIG, `import "./helpers.js";\n`),
        files: { "helpers.ts": `process.env["MOTEBIT_UNIT_COST"] ??= "0.30";\nexport {};\n` },
      });
      expect(v).toMatch(NAMES("helpers\\.ts"));
      expect(v).toMatch(WRITES("helpers\\.ts"));
    });
    it("plain assignment and Object.assign of the variable are RED", async () => {
      for (const stmt of [
        `process.env.MOTEBIT_UNIT_COST = "0.30";`,
        `Object.assign(process.env, { MOTEBIT_UNIT_COST: "0.30" });`,
      ]) {
        const v = await research({ src: atTop(stmt) });
        expect(v, stmt).toMatch(NAMES("index\\.ts"));
        expect(v, stmt).toMatch(WRITES("index\\.ts"));
      }
    });
    it("a string or template literal naming the variable is RED, even without a write", async () => {
      for (const stmt of [
        `const k = "MOTEBIT_UNIT_COST"; void k;`,
        "const k = `MOTEBIT_UNIT_COST`; void k;",
        "const k = `${'x'}MOTEBIT_UNIT_COST`; void k;",
        `const o = { MOTEBIT_UNIT_COST: 1 }; void o;`,
      ]) {
        const v = await research({ src: atTop(stmt) });
        expect(v, stmt).toMatch(NAMES("index\\.ts"));
        expect(v, stmt).not.toMatch(WRITES("index\\.ts"));
      }
    });
    it("a write of an unrelated env key is RED, in every write form", async () => {
      for (const stmt of [
        `process.env.FOO = "1";`,
        `process.env["FOO"] ||= "1";`,
        `process.env.FOO += "1";`,
        `delete process.env.FOO;`,
        `process.env = {};`,
        `Object.assign(process.env, { FOO: "1" });`,
        `Object.defineProperty(process.env, "FOO", { value: "1" });`,
        `Reflect.set(process.env, "FOO", "1");`,
        `(process.env as Record<string, string>)["FOO"] = "1";`,
      ]) {
        const v = await research({ src: atTop(stmt) });
        expect(v, stmt).toMatch(WRITES("index\\.ts"));
        expect(v, stmt).not.toMatch(NAMES("index\\.ts"));
      }
    });
    it("applies to market:false services too", async () => {
      const s = baseServices();
      s["relay"] = { ...s["relay"]!, src: `process.env.FOO = "1";\nexport {};\n` };
      expect(await violations({ services: s })).toMatch(
        /services\/relay\/src\/index\.ts:1: .* — env access is deny-by-default/,
      );
    });
    it("is GREEN for a test file doing the same, for env reads, and for comments", async () => {
      const both = `process.env["MOTEBIT_UNIT_COST"] ??= "0.30";\nprocess.env.FOO = "1";\nexport {};\n`;
      expect(await research({ files: { "index.test.ts": both } })).toBe("");
      expect(
        await research({
          src: atTop(
            `// the runner applies MOTEBIT_UNIT_COST\n  const port = process.env["PORT"] ?? process.env.HOST; if (process.env.FOO === "1") void port;`,
          ),
        }),
      ).toBe("");
    });
  });

  // Cold review after R7 (2026-10-06): the write rules matched spellings, and
  // each round found another — `process.loadEnvFile(".env")`, `import { env }
  // from "node:process"`, `const e = process.env; e.X = …`, `const { env: en }
  // = process`. DENY BY DEFAULT: env is touched only as a direct literal-key
  // READ (`process.env.NAME` / `process.env["NAME"]`); every other handle on
  // it is RED, in every service, outside tests.
  describe("R8: env access is deny-by-default", () => {
    const atTop = (stmt: string, prelude = "") =>
      swap(
        entry(CONFIG, prelude),
        "async function main(): Promise<void> {\n",
        `async function main(): Promise<void> {\n  ${stmt}\n`,
      );
    const DENIED =
      /services\/research\/src\/index\.ts:\d+: .* — env access is deny-by-default: read env only as process\.env\.NAME/;
    const RED: [string, string, string?][] = [
      ["loadEnvFile", `process.loadEnvFile(".env");`],
      [
        "loadEnvFile imported",
        `loadEnvFile(".env");`,
        `import { loadEnvFile } from "node:process";\n`,
      ],
      ["named env import + write", `env.FOO = "1";`, `import { env } from "node:process";\n`],
      ["aliased named env import", `en.FOO = "1";`, `import { env as en } from "process";\n`],
      [
        "Object.assign(env, …)",
        `Object.assign(env, { FOO: "1" });`,
        `import { env } from "node:process";\n`,
      ],
      ["default import aliased", `p.env.FOO = "1";`, `import p from "node:process";\n`],
      ["namespace import", `ns.env.FOO = "1";`, `import * as ns from "node:process";\n`],
      [
        "default import + alias of process.env",
        `const e = process.env; void e;`,
        `import process from "node:process";\n`,
      ],
      ["alias then write", `const e = process.env; e.FOO = "1";`],
      ["destructure env", `const { env } = process; env.FOO = "1";`],
      ["destructure env renamed", `const { env: en } = process; en.FOO = "1";`],
      [
        "destructure process from globalThis",
        `const { process: p } = globalThis; p.env.FOO = "1";`,
      ],
      ["process aliased", `const p = process; p.env.FOO = "1";`],
      ["dotenv/config", `void 0;`, `import "dotenv/config";\n`],
      ["dotenv", `dotenv.config();`, `import dotenv from "dotenv";\n`],
      ["@dotenvx", `void 0;`, `import "@dotenvx/dotenvx/config";\n`],
      ["require(node:process)", `require("node:process").env.FOO = "1";`],
      ["dynamic import(process)", `(await import("process")).env.FOO = "1";`],
      ["passed as an argument", `fn(process.env);`, `declare function fn(e: unknown): void;\n`],
      ["spread", `const o = { ...process.env }; void o;`],
      ["computed-key read", `const k = "FOO"; void process.env[k];`],
      ["globalThis alias", `const e = globalThis.process.env; void e;`],
      ["destructuring assignment write", `[process.env.FOO] = ["1"];`],
    ];
    for (const [label, stmt, prelude] of RED)
      it(`RED: ${label}`, async () => {
        expect(await research({ src: atTop(stmt, prelude) })).toMatch(DENIED);
      });
    it("GREEN: direct literal-key reads, typeof, other process members", async () => {
      for (const stmt of [
        `const a = process.env.FOO; void a;`,
        `const b = process.env["FOO"] ?? "x"; void b;`,
        `const c = globalThis.process.env.FOO; void c;`,
        `if (typeof process !== "undefined") void process.argv;`,
        "const t = `${process.env.FOO ?? ''}`; void t;",
      ])
        expect(await research({ src: atTop(stmt) }), stmt).toBe("");
      expect(
        await research({
          src: atTop(`const d = process.env.FOO; void d;`, `import process from "node:process";\n`),
        }),
      ).toBe("");
    });
    it("GREEN: the same violating code in a __tests__ file or *.test.ts", async () => {
      const bad =
        `import { env } from "node:process";\nimport "dotenv/config";\nprocess.loadEnvFile(".env");\n` +
        `const e = process.env; e.X = "1";\nconst { env: en } = process; void en;\nObject.assign(env, { A: "1" });\n` +
        `fn(process.env);\nconst o = { ...process.env }; void o;\ndeclare function fn(e: unknown): void;\nexport {};\n`;
      expect(await research({ files: { "index.test.ts": bad } })).toBe("");
      const s = baseServices();
      const dir = fixture({ services: s });
      mkdirSync(join(dir, "services", "research", "src", "__tests__"), { recursive: true });
      writeFileSync(join(dir, "services", "research", "src", "__tests__", "x.ts"), bad);
      expect((await evaluate(dir)).violations).toEqual([]);
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
      /`research` states \$0\.05\/task but services\/research\/src\/pricing\.ts LISTING_PRICE lists \$0\.25\/task/,
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
      /`research` states \$0\.25\/task but services\/research\/src\/pricing\.ts LISTING_PRICE lists \$0\.3\/task/,
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

  it("config pricing must be exactly LISTING_PRICE", async () => {
    for (const expr of [
      "{ ...LISTING_PRICE }",
      '{ ...LISTING_PRICE, per: "page" }',
      '{ capabilities: ["x"], unit_cost: 0.25, per: "task" }',
      'process.env["X"] ? undefined : LISTING_PRICE',
    ])
      expect(
        await research({ src: entry(`{ serviceName: "f", pricing: ${expr} }`) }),
        expr,
      ).toMatch(/runMolecule's `pricing` must be exactly `LISTING_PRICE`/);
    expect(
      await research({ src: entry(`{ pricing: LISTING_PRICE, pricing: undefined }`) }),
    ).toMatch(/has 2 `pricing` properties/);
    // A config built elsewhere cannot be checked: it must be the literal.
    expect(
      await research({ src: entry("cfg", "const cfg = { pricing: LISTING_PRICE };\n") }),
    ).toMatch(/config must be an object literal/);
  });

  it("LISTING_PRICE reaches the runner untouched: no mutation site, no second reader", async () => {
    expect(
      await research({
        src: entry(CONFIG, "(LISTING_PRICE as { unit_cost: number }).unit_cost = 9;\n"),
      }),
    ).toMatch(/names `LISTING_PRICE` outside runMolecule's `pricing`/);
    expect(
      await research({
        files: {
          "boot.ts": `import { LISTING_PRICE } from "./pricing.js";\n(LISTING_PRICE as { per: string }).per = "page";\n`,
        },
      }),
    ).toMatch(/services\/research\/src\/boot\.ts:1: names `LISTING_PRICE`/);
    expect(
      await research({
        files: { "boot.ts": `export async function f() { return import("./pricing.js"); }\n` },
      }),
    ).toMatch(/boot\.ts:1: imports "\.\/pricing\.js" — only src\/index\.ts reads the price module/);
    expect(await research({ src: entry(CONFIG, `import "./pricing.js";\n`) })).toMatch(
      /imports "\.\/pricing\.js" again/,
    );
    expect(
      await research({ src: entry(CONFIG, `import * as P from "./pricing.js";\nvoid P;\n`) }),
    ).toMatch(/`import \* as P from "\.\/pricing\.js"`/);
  });

  it("a spread after pricing could replace it (RED); a spread before it cannot (green)", async () => {
    expect(
      await research({
        src: entry(`{ pricing: LISTING_PRICE, ...extra }`, "const extra = {};\n"),
      }),
    ).toMatch(/a spread after `pricing` in runMolecule's config could replace it/);
    expect(
      await research({
        src: entry(`{ ...extra, pricing: LISTING_PRICE }`, "const extra = {};\n"),
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
        files: { "other.ts": "export const LISTING_PRICE = undefined;\n" },
      }),
    ).toMatch(/`LISTING_PRICE` is imported from "\.\/other\.js"/);
    expect(
      await research({
        src: entry(CONFIG, "", "  const LISTING_PRICE = {};\n  void LISTING_PRICE;\n"),
      }),
    ).toMatch(/re-binds `LISTING_PRICE`/);
    expect(
      await research({
        files: {
          "boot.ts": `import { runMolecule } from "@motebit/molecule-runner";\nvoid runMolecule;\n`,
        },
      }),
    ).toMatch(/services\/research\/src\/boot\.ts:\d+: names `runMolecule`/);
  });

  it("pricing.ts is literal data by shape — nothing runs, nothing reads the env", async () => {
    expect(
      await research({
        pricing: `import { readFileSync } from "node:fs";\n` + pricingModule("0.25", "task"),
      }),
    ).toMatch(
      /src\/pricing\.ts: line 1: .* holds type-only imports, types and ONE `export const LISTING_PRICE/,
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
    // `satisfies` is a type position; the literal is still checked.
    expect(
      await research({
        pricing: `export const LISTING_PRICE = { capabilities: ["x"], unit_cost: 0.25, per: "task" } satisfies object;\n`,
      }),
    ).toBe("");
  });

  it("every LISTING_PRICE value is a literal: arithmetic, calls, spreads and negatives are RED", async () => {
    for (const cost of ["0.125 * 2", 'Number("0.25")', "-0.25", "COST"])
      expect(await research({ pricing: pricingModule(cost, "task") }), cost).toMatch(
        /every LISTING_PRICE property is a plain `key: <literal>`/,
      );
    expect(
      await research({
        pricing: `const BASE = { per: "task" };\nexport const LISTING_PRICE = { ...BASE, capabilities: ["x"], unit_cost: 0.25 };\n`,
      }),
    ).toMatch(/line 1: `const BASE/);
    expect(await research({ pricing: pricingModule("0.25", "task", "[`x`]") })).toMatch(
      /plain `key: <literal>`/,
    );
  });

  it("refuses an empty, malformed or multi-shape LISTING_PRICE", async () => {
    expect(await research({ pricing: pricingModule("0.25", "task", "[]") })).toMatch(
      /LISTING_PRICE is \{"capabilities":\[\],.*exactly \{ capabilities: non-empty string\[\]/,
    );
    expect(await research({ pricing: pricingModule(`"0.25"`, "task") })).toMatch(
      /exactly \{ capabilities: non-empty string\[\], unit_cost: finite number/,
    );
    expect(
      await research({
        pricing: `export const LISTING_PRICE = { capabilities: ["x"], unit_cost: 0.25, per: "task", currency: "EUR" };\n`,
      }),
    ).toMatch(/LISTING_PRICE is .*"currency":"EUR"/);
    expect(
      await research({
        pricing: `export const LISTING_PRICE = { capabilities: ["x"], unit_cost: 0.25, per: "task", per: "page" };\n`,
      }),
    ).toMatch(/per: "page"` — every LISTING_PRICE property is a plain `key: <literal>`, once/);
    expect(
      await research({
        pricing: `export function listingPricing() { return []; }\n`,
      }),
    ).toMatch(/line 1: `export function listingPricing\(\) \{ return \[\]; \}`/);
    expect(await research({ pricing: `export type X = 1;\n` })).toMatch(
      /exports no `LISTING_PRICE`/,
    );
  });

  it("the runner's override rule is the one the gate pins: sentinel to every entry, malformed refused", async () => {
    const { resolveListingPricing } =
      await import("../../packages/molecule-runner/src/listing-price.js");
    const spec = { capabilities: ["x", "y"], unit_cost: 0.25, per: "task" };
    for (const e of resolveListingPricing(spec, "0.123457")) expect(e.unit_cost).toBe(0.123457);
    for (const bad of MALFORMED_COSTS)
      expect(() => resolveListingPricing(spec, bad), bad).toThrow(/MOTEBIT_UNIT_COST/);
    expect(resolveListingPricing(spec, " 0.37 ").map((e) => e.unit_cost)).toEqual([0.37, 0.37]);
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
      /services\/research\/\.env\.example:2: MOTEBIT_UNIT_COST=0\.05 but services\/research\/src\/pricing\.ts LISTING_PRICE lists \$0\.25\/task by default/,
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
