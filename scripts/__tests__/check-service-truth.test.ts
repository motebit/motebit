/**
 * check-service-truth self-test — fixture round-trips, prices by EXECUTION.
 *
 * Builds a miniature repo (services/* with `motebit` metadata and a real
 * entry `src/index.ts` whose main() calls `runMolecule` from
 * `@motebit/molecule-runner` with a builder returning `getServiceListing`, a
 * README `## Architecture` section, an architecture.mdx tree + `## Services`
 * table) that the gate passes, then applies one mutation per drift class and
 * requires RED naming it. The gate runs each fixture entry for real, with
 * `runMolecule` captured (scripts/lib/listing-probe/), so every listing case
 * below is decided by what main() actually lists — including the cold-review
 * bypasses an AST-matching version missed (B1: a renamed, dead
 * `getServiceListing`; B2: a post-construction `per` rewrite; B3: a spread
 * override; B4: a different listing object; B5: a market:false service that
 * lists a price). Finally runs the real gate on the real repo through its CLI.
 */
import { describe, it as vitestIt, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, probeListing, ARCHITECTURE_PATH } from "../check-service-truth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

// Each evaluate() spawns a node child per listing service and env.
const it = (name: string, fn: () => Promise<void>) => vitestIt(name, fn, 120_000);

interface Svc {
  role: string;
  identity: boolean;
  market: boolean;
  /** Source of services/<name>/src/index.ts — the entry the gate executes. */
  src: string;
  /** Source of services/<name>/src/pricing.ts, when the service has one. */
  pricing?: string;
  /** Extra files under services/<name>/src. */
  files?: Record<string, string>;
  /** motebit.listingProbeEnv. */
  probeEnv?: Record<string, string>;
  /** services/<name>/.env.example. */
  envExample?: string;
}

/** The listing object main() hands the runner, as an expression. */
const LISTING_OBJ = `{ capabilities: ["x"], pricing: listingPricing(process.env) }`;

/** A service entry: main() → runMolecule(config, builder → { getServiceListing }). */
const entry = (build: string, prelude = "", after = "") =>
  `import { runMolecule } from "@motebit/molecule-runner";\n` +
  `import { listingPricing } from "./pricing.js";\n` +
  prelude +
  `async function main(): Promise<void> {\n` +
  `  await runMolecule({ serviceName: "fixture" } as never, () => (${build}) as never);\n` +
  after +
  `}\n` +
  `main().catch((err: unknown) => { console.error(String(err)); process.exit(1); });\n`;

const ENTRY = entry(
  `{ toolRegistry: {}, getServiceListing: () => Promise.resolve(${LISTING_OBJ}) }`,
);

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
  /** Extra files at the fixture root (e.g. a node_modules package). */
  rootFiles?: Record<string, string>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "st-service-truth-"));
  dirs.push(root);
  const services = opts.services ?? baseServices();
  for (const [name, s] of Object.entries(services)) {
    const src = join(root, "services", name, "src");
    mkdirSync(src, { recursive: true });
    const pkg: Record<string, unknown> = { name: `@motebit/${name}`, type: "module" };
    if (s != null)
      pkg["motebit"] = {
        role: s.role,
        identity: s.identity,
        market: s.market,
        ...(s.probeEnv != null ? { listingProbeEnv: s.probeEnv } : {}),
      };
    writeFileSync(join(root, "services", name, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(src, "index.ts"), s?.src ?? "export {};\n");
    if (s?.pricing != null) writeFileSync(join(src, "pricing.ts"), s.pricing);
    for (const [f, body] of Object.entries(s?.files ?? {})) writeFileSync(join(src, f), body);
    if (s?.envExample != null)
      writeFileSync(join(root, "services", name, ".env.example"), s.envExample);
  }
  for (const [f, body] of Object.entries(opts.rootFiles ?? {})) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
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

describe("check-service-truth", () => {
  it("is silent on a consistent fixture, and reads the price by executing main()", async () => {
    const r = await evaluate(fixture({}));
    expect(r.violations).toEqual([]);
    expect(r.placements).toBe(12);
    expect(r.countClaims).toBeGreaterThanOrEqual(8);
    expect(r.services.find((s) => s.name === "research")!.price).toEqual({
      amount: 0.25,
      per: "task",
      source: "services/research/src/index.ts (executed)",
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
      /`research` states \$0\.05\/task but services\/research\/src\/index\.ts \(executed\) lists \$0\.25\/task/,
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

  it("ties the market flag to what main() lists", async () => {
    // market:false reading MOTEBIT_UNIT_COST anywhere in its source.
    const s = baseServices();
    s["embed"] = { ...s["embed"]!, pricing: pricingModule("0.01", "request") };
    expect(await violations({ services: s })).toMatch(
      /services\/embed: motebit\.market is false but services\/embed\/src\/pricing\.ts reads MOTEBIT_UNIT_COST/,
    );
    // market:true whose main() never reaches the runner.
    expect(await research({ src: "export {};\n" })).toMatch(
      /services\/research: motebit\.market is true but executing services\/research\/src\/index\.ts never called runMolecule \(exit 0\)/,
    );
    const u = baseServices();
    u["research"] = { ...u["research"]!, identity: false };
    expect(await violations({ services: u })).toMatch(/only a service with an identity can list/);
  });

  // ── the cold-review bypasses: decided by what main() lists ──────────────

  it("B1: a renamed (dead) getServiceListing — main() lists nothing", async () => {
    const v = await research({
      src: ENTRY.replace("getServiceListing:", "_retiredListing:"),
    });
    expect(v).toMatch(
      /services\/research: motebit\.market is true but the build services\/research\/src\/index\.ts hands runMolecule has no getServiceListing/,
    );
  });

  it("B2: tweak() rewrites every entry's per after construction", async () => {
    const v = await research({
      src: entry(
        `{ toolRegistry: {}, getServiceListing: () => Promise.resolve(tweak(${LISTING_OBJ})) }`,
        `function tweak<T extends { pricing: { per: string }[] }>(l: T): T {\n` +
          `  for (const p of l.pricing) p.per = "page";\n  return l;\n}\n`,
      ),
    });
    expect(v).toMatch(
      /`research` states \$0\.25\/task but services\/research\/src\/index\.ts \(executed\) lists \$0\.25\/page/,
    );
  });

  it("B3: a spread overrides the listing's per", async () => {
    const v = await research({
      src: entry(
        `{ toolRegistry: {}, getServiceListing: () => Promise.resolve({ ...${LISTING_OBJ}, ...{ ["pricing"]: listingPricing(process.env).map((p) => ({ ...p, per: "page" })) } }) }`,
      ),
    });
    expect(v).toMatch(/`research` states \$0\.25\/task but .* lists \$0\.25\/page/);
  });

  it("B4: getServiceListing returns a different object than the canonical one", async () => {
    const v = await research({
      src: entry(
        `{ toolRegistry: {}, _canonical: () => Promise.resolve(${LISTING_OBJ}), getServiceListing: () => Promise.resolve(JSON.parse('{"capabilities":["x"],"pricing":[{"capability":"x","unit_cost":0.5,"currency":"USD","per":"task"}]}')) }`,
      ),
    });
    expect(v).toMatch(/`research` states \$0\.25\/task but .* lists \$0\.5\/task/);
    expect(v).toMatch(/with MOTEBIT_UNIT_COST="0\.123457", executing .* lists unit_costs \[0\.5\]/);
  });

  it("B5: a market:false service whose main() lists a price", async () => {
    const s = baseServices();
    s["embed"] = {
      ...s["embed"]!,
      src: entry(
        `{ toolRegistry: {}, getServiceListing: () => Promise.resolve({ capabilities: ["e"], pricing: [{ capability: "e", unit_cost: 0.02, currency: "USD", per: "request" }] }) }`,
      ).replace(`import { listingPricing } from "./pricing.js";\n`, ""),
    };
    expect(await violations({ services: s })).toMatch(
      /services\/embed: motebit\.market is false but executing services\/embed\/src\/index\.ts lists pricing \[\{"capability":"e","unit_cost":0\.02/,
    );
  });

  it("P1: arithmetic on the price — in pricing.ts or on the listing in main()", async () => {
    const v1 = await research({
      pricing: pricingModule("0.25", "task").replace('"0.25");', '"0.25") * 2;'),
    });
    expect(v1).toMatch(/`research` states \$0\.25\/task but .* lists \$0\.5\/task/);
    expect(v1).toMatch(/with MOTEBIT_UNIT_COST="0\.123457", .* lists unit_costs \[0\.246914\]/);
    const v2 = await research({
      src: ENTRY.replace(
        "listingPricing(process.env) }",
        "listingPricing(process.env).map((p) => ({ ...p, unit_cost: p.unit_cost * 2 })) }",
      ),
    });
    expect(v2).toMatch(/`research` states \$0\.25\/task but .* lists \$0\.5\/task/);
  });

  it("P2: a hardcoded unit_cost — even one that equals the docs (dead override)", async () => {
    expect(await research({ pricing: pricingModule("0.25", "task", "0.25") })).toMatch(
      /lists unit_costs \[0\.25\] — every entry's unit_cost must be the parsed override/,
    );
    const v = await research({
      src: ENTRY.replace(
        "pricing: listingPricing(process.env)",
        `pricing: [{ capability: "x", unit_cost: 0.5, currency: "USD", per: "task" }]`,
      ),
    });
    expect(v).toMatch(/lists \$0\.5\/task/);
  });

  it("refuses an empty or malformed listing, a throwing builder and two runMolecule calls", async () => {
    expect(await research({ src: ENTRY.replace("listingPricing(process.env)", "[]") })).toMatch(
      /getServiceListing\(\) lists no pricing/,
    );
    expect(
      await research({ pricing: pricingModule("0.25", "task").replace('"USD"', '"EUR"') }),
    ).toMatch(/lists a pricing entry that is not \{ capability/);
    expect(
      await research({
        src: entry(`(() => { throw new Error("boom"); })()`),
      }),
    ).toMatch(/the builder or its getServiceListing threw \(boom\)/);
    expect(
      await research({
        src: entry(
          `{ toolRegistry: {}, getServiceListing: () => Promise.resolve(${LISTING_OBJ}) }`,
          "",
          `  await runMolecule({ serviceName: "again" } as never, () => ({ toolRegistry: {} }) as never);\n`,
        ),
      }),
    ).toMatch(/called runMolecule 2 times/);
  });

  it("boots main() with motebit.listingProbeEnv, never with MOTEBIT_UNIT_COST", async () => {
    const needsKey = entry(
      `{ toolRegistry: {}, getServiceListing: () => Promise.resolve(${LISTING_OBJ}) }`,
    ).replace(
      "async function main(): Promise<void> {\n",
      `async function main(): Promise<void> {\n  if (!process.env["API_KEY"]) { console.error("API_KEY is required"); process.exit(1); }\n`,
    );
    expect(await research({ src: needsKey })).toMatch(
      /never called runMolecule \(exit 1 — stderr: API_KEY is required\) — if main\(\) needs env to boot, declare inert values in package\.json motebit\.listingProbeEnv/,
    );
    expect(await research({ src: needsKey, probeEnv: { API_KEY: "probe" } })).toBe("");
    expect(await research({ probeEnv: { MOTEBIT_UNIT_COST: "0.25" } })).toMatch(
      /motebit\.listingProbeEnv may not set MOTEBIT_UNIT_COST/,
    );
  });

  it(".env.example must state the coded default (value and comment)", async () => {
    expect(
      await research({ envExample: "# Price per task (default: 0.25)\nMOTEBIT_UNIT_COST=0.25\n" }),
    ).toBe("");
    expect(await research({ envExample: "# Listed price\nMOTEBIT_UNIT_COST=0.05\n" })).toMatch(
      /services\/research\/\.env\.example:2: MOTEBIT_UNIT_COST=0\.05 but services\/research\/src\/index\.ts \(executed\) lists \$0\.25\/task by default/,
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

  // ── second cold review: call count, subpath import, identity ────────────

  it("G1: getServiceListing must list the same thing on every call the runner makes", async () => {
    // The runner calls it for task admission, again to register with the relay,
    // and again per motebit_service_listing tool call. A listing that only the
    // first call gets right is a different listing in the relay.
    const v = await research({
      src: entry(
        `{ toolRegistry: {}, getServiceListing: () => Promise.resolve(n++ === 0 ? ${LISTING_OBJ} : { capabilities: ["x"], pricing: listingPricing(process.env).map((p) => ({ ...p, per: "page" })) }) }`,
        `let n = 0;\n`,
      ),
    });
    expect(v).toMatch(
      /services\/research: executing services\/research\/src\/index\.ts, getServiceListing\(\) returned different listings across the 3 calls the runner makes/,
    );
  });

  /** A stand-in for the real runner package, reachable only by a subpath. */
  const REAL_RUNNER = {
    "node_modules/@motebit/molecule-runner/package.json": JSON.stringify({
      name: "@motebit/molecule-runner",
      type: "module",
      main: "dist/index.js",
    }),
    // The "real" runner boots a server on MOTEBIT_PORT (default 3200) and stays up.
    "node_modules/@motebit/molecule-runner/dist/index.js":
      `import { createServer } from "node:http";\n` +
      `export async function runMolecule(config, build) {\n` +
      `  await build({ motebitId: "real" }, undefined);\n` +
      `  createServer(() => {}).listen(Number(process.env.MOTEBIT_PORT ?? 3200));\n` +
      `}\n`,
  };
  const SUBPATH = `import { runMolecule } from "@motebit/molecule-runner/dist/index.js";\n`;
  const RUNNER_IMPORT = `import { runMolecule } from "@motebit/molecule-runner";\n`;
  const PRICED_EMBED = entry(
    `{ toolRegistry: {}, getServiceListing: () => Promise.resolve({ capabilities: ["e"], pricing: [{ capability: "e", unit_cost: 0.02, currency: "USD", per: "request" }] }) }`,
  ).replace(`import { listingPricing } from "./pricing.js";\n`, "");

  it("G4a: a market:true service importing the runner by subpath is probed, not booted", async () => {
    const s = baseServices();
    s["research"] = {
      ...s["research"]!,
      src: ENTRY.replace(RUNNER_IMPORT, SUBPATH),
      pricing: pricingModule("0.5", "task"),
    };
    const t0 = Date.now();
    const v = await violations({ services: s, rootFiles: REAL_RUNNER });
    expect(v).toMatch(/`research` states \$0\.25\/task but .* lists \$0\.5\/task/);
    expect(Date.now() - t0, "decided by the captured listing, not a timeout").toBeLessThan(30_000);
  });

  it("G4b: a market:false service importing the runner by subpath, with a hard-coded price", async () => {
    const s = baseServices();
    s["embed"] = { ...s["embed"]!, src: PRICED_EMBED.replace(RUNNER_IMPORT, SUBPATH) };
    expect(await violations({ services: s, rootFiles: REAL_RUNNER })).toMatch(
      /services\/embed: motebit\.market is false but executing services\/embed\/src\/index\.ts lists pricing \[\{"capability":"e","unit_cost":0\.02/,
    );
  });

  it("G4c: a market:false service reaching runMolecule by a computed specifier", async () => {
    // No import the source scan can see: decided by execution alone.
    const s = baseServices();
    s["embed"] = {
      ...s["embed"]!,
      src: PRICED_EMBED.replace(
        RUNNER_IMPORT,
        `const { runMolecule } = (await import(["@motebit", "molecule-runner"].join("/"))) as { runMolecule: (c: unknown, b: unknown) => Promise<unknown> };\n`,
      ),
    };
    expect(await violations({ services: s, rootFiles: REAL_RUNNER })).toMatch(
      /services\/embed: motebit\.market is false but executing services\/embed\/src\/index\.ts lists pricing/,
    );
  });

  it("G2: each probe run hands the builder a fresh, realistic identity", async () => {
    const root = fixture({});
    const e = join(root, "services", "research", "src", "index.ts");
    const [a, b] = await Promise.all([probeListing(e, {}), probeListing(e, {})]);
    const ids = [a, b].map((r) => r.calls[0]?.identity?.motebitId);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(a.calls[0]?.identity?.deviceId).not.toBe(b.calls[0]?.identity?.deviceId);
  });

  it("the real repo passes through the CLI, with an aperture line", async () => {
    const r = spawnSync("npx", ["tsx", join(ROOT, "scripts/check-service-truth.ts")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Aperture: proves these two docs and each \.env\.example match/);
  });
});
