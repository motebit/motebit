/**
 * check-service-truth self-test — fixture round-trips.
 *
 * Builds a miniature repo (services/* with `motebit` metadata + coded
 * MOTEBIT_UNIT_COST defaults, a README `## Architecture` section, an
 * architecture.mdx tree + `## Services` table) that the gate passes, then
 * applies one mutation per drift class and requires RED naming it: wrong role,
 * wrong price, wrong unit, missing service, duplicate service, missing
 * metadata, count mismatch, retired "glue", market flag vs code. Finally runs
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
}

const priced = (amount: string, per: string) =>
  `const unitCost = parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "${amount}");\n` +
  `export const pricing = [{ capability: "x", unit_cost: unitCost, currency: "USD", per: "${per}" }];\n`;

function baseServices(): Record<string, Svc> {
  return {
    relay: { role: "relay", identity: true, market: false, src: "export {};\n" },
    research: { role: "molecule", identity: true, market: true, src: priced("0.25", "task") },
    "read-url": { role: "atom", identity: true, market: true, src: priced("0", "request") },
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
      /`research` states \$0\.05\/task but services\/research\/src\/index\.ts codes \$0\.25\/task/,
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
    s["embed"] = { ...s["embed"]!, src: priced("0.01", "request") };
    expect(evaluate(fixture({ services: s })).violations.join("\n")).toMatch(
      /services\/embed: motebit\.market is false but .* codes a MOTEBIT_UNIT_COST default/,
    );
    const t = baseServices();
    t["research"] = { ...t["research"]!, src: "export {};\n" };
    expect(evaluate(fixture({ services: t })).violations.join("\n")).toMatch(
      /services\/research: motebit\.market is true but its source carries no/,
    );
    const u = baseServices();
    u["research"] = { ...u["research"]!, identity: false };
    expect(evaluate(fixture({ services: u })).violations.join("\n")).toMatch(
      /only a service with an identity can list/,
    );
  });

  it("refuses an unparseable coded default", () => {
    const s = baseServices();
    s["research"] = {
      ...s["research"]!,
      src: `const c = process.env["MOTEBIT_UNIT_COST"] ?? DEFAULT;\nexport const p = [{ per: "task" }];\n`,
    };
    expect(evaluate(fixture({ services: s })).violations.join("\n")).toMatch(
      /1 read\(s\) of process\.env MOTEBIT_UNIT_COST but 0 with a literal/,
    );
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
