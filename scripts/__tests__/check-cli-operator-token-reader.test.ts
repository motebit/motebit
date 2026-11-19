/**
 * check-cli-operator-token-reader — real-repo smoke + planted breaks.
 *
 * Each planted case copies the CLI's non-test source into a temp tree,
 * applies ONE edit that re-opens the door (a second reader of the operator
 * token, a second writer of the record, a second way to the relay server's
 * resolver), and requires the gate to fail naming it. If someone weakens a
 * rule, its planted case stops failing and this goes red.
 *
 * Tamper: scripts/tampers/cli-operator-token-per-relay.ts
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasApertureDisclosure, hasRepairInstruction } from "../lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-cli-operator-token-reader.ts");
const TSX = resolve(ROOT, "node_modules", ".bin", "tsx");
const SRC = "apps/cli/src";

// Every case spawns the gate, about a second each when idle and several when
// the machine is loaded (the tamper runner runs many copies at once).
vi.setConfig({ testTimeout: 60_000 });

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(root?: string) {
  return spawnSync(TSX, [SCRIPT, ...(root !== undefined ? ["--root", root] : [])], {
    encoding: "utf-8",
    cwd: ROOT,
  });
}

type Edit =
  | { file: string; from: string; to: string }
  | { file: string; append: string }
  | { file: string; create: string };

/** A copy of the CLI's source (tests left out), with `edits` applied. */
function plantedTree(edits: Edit[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-operator-token-gate-"));
  temps.push(dir);
  cpSync(join(ROOT, SRC), join(dir, SRC), {
    recursive: true,
    filter: (src) => !src.includes("__tests__"),
  });
  for (const e of edits) {
    const abs = join(dir, e.file);
    if ("create" in e) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, e.create);
      continue;
    }
    const src = readFileSync(abs, "utf-8");
    if ("append" in e) {
      writeFileSync(abs, `${src}\n${e.append}\n`);
      continue;
    }
    const parts = src.split(e.from);
    if (parts.length !== 2) {
      throw new Error(`${e.file}: expected exactly one occurrence of ${JSON.stringify(e.from)}`);
    }
    writeFileSync(abs, parts.join(e.to));
  }
  return dir;
}

function expectFails(edits: Edit[], naming: string | RegExp): void {
  const r = run(plantedTree(edits));
  const out = `${r.stdout}${r.stderr}`;
  expect(r.status, out).toBe(1);
  if (typeof naming === "string") expect(out).toContain(naming);
  else expect(out).toMatch(naming);
  expect(hasRepairInstruction(out).ok, out).toBe(true);
}

const OTHER = `${SRC}/subcommands/discover.ts`;
const RELAY_SERVER = `${SRC}/subcommands/relay.ts`;

describe("check-cli-operator-token-reader", () => {
  it("passes on the repo and states what it scanned", () => {
    const r = run();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("check-cli-operator-token-reader");
    expect(r.stdout).toMatch(/\d+ source file\(s\) scanned/);
    expect(r.stdout).toContain("2 allowed reader file(s) found");
    expect(r.stdout).toContain("NOT CAUGHT");
    expect(hasApertureDisclosure(r.stdout).ok).toBe(true);
  });

  it("passes on an unedited copy (the planted tree itself is sound)", () => {
    const r = run(plantedTree([]));
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  describe("R1 — a reader added to another file", () => {
    it("as a property read", () => {
      expectFails(
        [
          {
            file: OTHER,
            append: "export const leak = (c: { syncToken?: string }) => c.syncToken;",
          },
        ],
        `${OTHER}:`,
      );
    });

    it("as an index read", () => {
      expectFails(
        [
          {
            file: OTHER,
            append: 'export const leak = (c: Record<string, unknown>) => c["syncToken"];',
          },
        ],
        "the text `syncToken` in a string",
      );
    });

    it("as a destructured read", () => {
      expectFails(
        [
          {
            file: OTHER,
            append:
              "export function leak(c: Record<string, string>): string | undefined {\n  const { syncToken } = c;\n  return syncToken;\n}",
          },
        ],
        "the identifier `syncToken`",
      );
    });

    it("as a string naming the api variable", () => {
      expectFails(
        [{ file: OTHER, append: 'export const leak = () => process.env["MOTEBIT_API_TOKEN"];' }],
        "the text `MOTEBIT_API_TOKEN` in a string",
      );
    });

    it("as a string naming the sync variable", () => {
      expectFails(
        [{ file: OTHER, append: 'export const leak = () => process.env["MOTEBIT_SYNC_TOKEN"];' }],
        "the text `MOTEBIT_SYNC_TOKEN` in a string",
      );
    });

    it("as a dotted environment read", () => {
      expectFails(
        [{ file: OTHER, append: "export const leak = () => process.env.MOTEBIT_API_TOKEN;" }],
        "the identifier `MOTEBIT_API_TOKEN`",
      );
    });

    it("as a variable name inside a template with substitutions", () => {
      expectFails(
        [
          {
            file: OTHER,
            append:
              "export const leak = (n: number) => `${String(n)} set MOTEBIT_SYNC_TOKEN ${String(n)}`;",
          },
        ],
        "the text `MOTEBIT_SYNC_TOKEN` in a string",
      );
    });

    it("as the flag's name in a string", () => {
      expectFails(
        [{ file: OTHER, append: 'export const hint = "pass --sync-token <token>";' }],
        "the text `sync-token` in a string",
      );
    });

    it("in a new file", () => {
      expectFails(
        [
          {
            file: `${SRC}/new-reader.ts`,
            create: 'export const t = () => process.env["MOTEBIT_API_TOKEN"];\n',
          },
        ],
        `${SRC}/new-reader.ts:1`,
      );
    });

    it("any match in subcommands/relay.ts", () => {
      expectFails(
        [
          {
            file: RELAY_SERVER,
            append: 'export const hint = "export MOTEBIT_API_TOKEN=<token>";',
          },
        ],
        `${RELAY_SERVER}:`,
      );
    });

    it("a mention in a comment alone does not fail", () => {
      const r = run(
        plantedTree([
          {
            file: OTHER,
            append:
              "// MOTEBIT_API_TOKEN, MOTEBIT_SYNC_TOKEN, --sync-token and config.syncToken are read elsewhere.\n/* syncToken */",
          },
        ]),
      );
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    });
  });

  describe("R2 — the record has one writer and one caller", () => {
    it("a second file imports bindOperatorToken", () => {
      expectFails(
        [
          {
            file: OTHER,
            append:
              'import { bindOperatorToken } from "../relay-operator-token.js";\nexport const rebind = bindOperatorToken;',
          },
        ],
        "names `bindOperatorToken`",
      );
    });

    it("a second file reaches it through a namespace import", () => {
      expectFails(
        [
          {
            file: OTHER,
            append:
              'import * as tokens from "../relay-operator-token.js";\nexport const rebind = tokens.bindOperatorToken;',
          },
        ],
        "names `bindOperatorToken`",
      );
    });

    it("the handler no longer calls it", () => {
      expectFails(
        [
          {
            file: `${SRC}/subcommands/relay-bind-token.ts`,
            create: "export function handleRelayBindToken(): void {}\n",
          },
        ],
        "does not name `bindOperatorToken`",
      );
    });
  });

  describe("R3 — the relay server's resolver stays in its file", () => {
    it("another file references resolveRelayApiToken", () => {
      expectFails(
        [
          {
            file: OTHER,
            append:
              'import { resolveRelayApiToken } from "./relay.js";\nexport const leak = () => resolveRelayApiToken(":memory:").apiToken;',
          },
        ],
        "names `resolveRelayApiToken`",
      );
    });
  });

  describe("R4 — the relay package has one importer", () => {
    it("another file imports @motebit/relay", () => {
      expectFails(
        [
          {
            file: OTHER,
            append:
              'import { resolveRelayAuthPosture } from "@motebit/relay";\nexport const posture = resolveRelayAuthPosture;',
          },
        ],
        'names the module "@motebit/relay"',
      );
    });

    it("another file imports it dynamically", () => {
      expectFails(
        [{ file: OTHER, append: 'export const lazy = () => import("@motebit/relay");' }],
        'names the module "@motebit/relay"',
      );
    });

    it("@motebit/relay-client is a different package and stays allowed", () => {
      const r = run(
        plantedTree([
          {
            file: OTHER,
            append: 'export type { RelayClient } from "@motebit/relay-client";',
          },
        ]),
      );
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    });
  });

  describe("aperture — only __tests__/ directories and *.test.ts files are left out", () => {
    const READ = "export const t = (): string | undefined => process.env.MOTEBIT_API_TOKEN;\n";
    for (const [what, file] of [
      ["a *.probe.ts file beside the code", `${SRC}/subcommands/discover.probe.ts`],
      ["a *.spec.ts file beside the code", `${SRC}/subcommands/discover.spec.ts`],
      ["a file under a dist/ directory", `${SRC}/dist/reader.ts`],
      ["a file under a coverage/ directory", `${SRC}/coverage/reader.ts`],
      ["a file under a __fixtures__/ directory", `${SRC}/__fixtures__/reader.ts`],
      ["a file under a node_modules/ directory", `${SRC}/node_modules/reader.ts`],
      ["a *.d.ts file", `${SRC}/reader.d.ts`],
    ] as const) {
      it(`${what} is scanned`, () => {
        expectFails([{ file, create: READ }], `${file}:1`);
      });
    }

    it("a *.test.ts file is not scanned", () => {
      const r = run(plantedTree([{ file: `${SRC}/subcommands/discover.test.ts`, create: READ }]));
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    });

    it("a file under a __tests__/ directory is not scanned", () => {
      const r = run(plantedTree([{ file: `${SRC}/__tests__/reader.ts`, create: READ }]));
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    });
  });

  describe("the two sites no behaviour reaches are held here", () => {
    it("run's plan-delegation token factory put back on its own read", () => {
      expectFails(
        [
          {
            file: `${SRC}/daemon.ts`,
            from: '        if (!fullConfig.device_id) return operator?.token ?? "";\n',
            to: '        if (!fullConfig.device_id)\n          return config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"] ?? "";\n',
          },
        ],
        `${SRC}/daemon.ts:`,
      );
    });

    it("serve --self-test's token fallback put back on its own read", () => {
      expectFails(
        [
          {
            file: `${SRC}/daemon.ts`,
            from: '            return operator?.token ?? "";\n          };\n',
            to: '            return config.syncToken ?? process.env["MOTEBIT_API_TOKEN"] ?? "";\n          };\n',
          },
        ],
        `${SRC}/daemon.ts:`,
      );
    });
  });

  it("the module missing is a failure", () => {
    const dir = plantedTree([]);
    rmSync(join(dir, SRC, "relay-operator-token.ts"));
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("does not exist");
  });

  it("stays GREEN on the whole-environment pass-through it says it cannot see", () => {
    // The stated blind spot, recorded: a sender that hands the whole
    // environment to code outside apps/cli/src and picks the token out by a
    // name built at run time. This is the edit
    // scripts/tampers/cli-operator-token-per-relay.ts makes to `motebit
    // serve`; there the subprocess row goes red. Here the gate must PASS —
    // if it ever fails on this, its header and this case are out of date.
    const r = run(
      plantedTree([
        {
          file: `${SRC}/daemon.ts`,
          from: "    const operator = operatorTokenFor(syncUrl, SERVE_TOKEN_SOURCES, config);\n",
          to:
            '    const own = Object.fromEntries(Object.entries(process.env))[["MOTEBIT", "API", "TOKEN"].join("_")];\n' +
            "    const operator = (own ? { relayUrl: syncUrl, token: own } : undefined) as ReturnType<typeof operatorTokenFor>;\n",
        },
      ]),
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });
});
