/**
 * check-molecule-spend-containment — real-repo smoke + planted breaks.
 *
 * Each planted case copies the files the gate scans (the mint constants, the
 * runner's source, one small molecule service) into a temp tree, applies ONE
 * edit that re-opens the door, and requires the gate to fail naming it. If
 * someone weakens a rule, its planted case stops failing and this goes red.
 *
 * Tamper: scripts/tampers/molecule-spend-containment.ts
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hasApertureDisclosure, hasRepairInstruction } from "../lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-molecule-spend-containment.ts");
const CONSTANTS = "packages/wallet-solana/src/constants.ts";
const RUNNER = "packages/molecule-runner/src/index.ts";
const SERVICE = "services/clerk/src/index.ts";
const SERVICE_IMPORT =
  'import { buildServiceReceipt, runMolecule } from "@motebit/molecule-runner";';
const MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(root?: string) {
  return spawnSync("npx", ["tsx", SCRIPT, ...(root !== undefined ? ["--root", root] : [])], {
    encoding: "utf-8",
    cwd: ROOT,
  });
}

/** A copy of the scanned files, with `edits` applied (each `from` must occur exactly once). */
function plantedTree(edits: Array<{ file: string; from: string; to: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "molecule-spend-gate-"));
  temps.push(dir);
  for (const rel of [CONSTANTS]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  for (const rel of ["packages/molecule-runner/src", "services/clerk/src"]) {
    cpSync(join(ROOT, rel), join(dir, rel), { recursive: true });
  }
  for (const e of edits) {
    const abs = join(dir, e.file);
    const src = readFileSync(abs, "utf-8");
    const parts = src.split(e.from);
    if (parts.length !== 2)
      throw new Error(`planted edit: \`${e.from}\` occurs ${parts.length - 1}× in ${e.file}`);
    writeFileSync(abs, parts.join(e.to));
  }
  return dir;
}

describe("check-molecule-spend-containment", () => {
  it("passes on the real repo and states its aperture and what it cannot see", () => {
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(hasApertureDisclosure(r.stdout).ok).toBe(true);
    expect(r.stdout).toMatch(/\d+ source file\(s\) scanned/);
    expect(r.stdout).toContain("7 molecule service(s)");
    expect(r.stdout).toContain("research");
    expect(r.stdout).toContain("clerk");
    expect(r.stdout).toContain("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(r.stdout).toContain("NOT CAUGHT:");
  });

  it("passes on an unedited copy of the scanned files (the planted harness itself is sound)", () => {
    const r = run(plantedTree([]));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("1 molecule service(s): clerk");
  });

  const PLANTED: Array<{
    name: string;
    edits: Array<{ file: string; from: string; to: string }>;
    names: RegExp;
  }> = [
    {
      name: "the constant widened with the mainnet mint literal",
      edits: [
        {
          file: RUNNER,
          from: "Object.freeze([USDC_MINT_DEVNET])",
          to: `Object.freeze([USDC_MINT_DEVNET, "${MAINNET}"])`,
        },
      ],
      names: /MOLECULE_SPENDABLE_MINTS must be the top-level/,
    },
    {
      name: "the constant replaced by a different single mint",
      edits: [
        {
          file: RUNNER,
          from: "Object.freeze([USDC_MINT_DEVNET])",
          to: `Object.freeze(["${MAINNET}"])`,
        },
      ],
      names: /MOLECULE_SPENDABLE_MINTS must be the top-level/,
    },
    {
      name: "the constant no longer frozen",
      edits: [
        { file: RUNNER, from: "Object.freeze([USDC_MINT_DEVNET])", to: "[USDC_MINT_DEVNET]" },
      ],
      names: /MOLECULE_SPENDABLE_MINTS must be the top-level/,
    },
    {
      name: "the constant read from the environment",
      edits: [
        {
          file: RUNNER,
          from: "Object.freeze([USDC_MINT_DEVNET])",
          to: 'Object.freeze((process.env.MOTEBIT_SPENDABLE_MINTS ?? USDC_MINT_DEVNET).split(","))',
        },
      ],
      names: /MOLECULE_SPENDABLE_MINTS must be the top-level/,
    },
    {
      name: "the devnet name swapped to the mainnet value in wallet-solana",
      edits: [
        {
          file: CONSTANTS,
          from: 'export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";',
          to: `export const USDC_MINT_DEVNET = "${MAINNET}";`,
        },
      ],
      names: /USDC_MINT_DEVNET is "EPjF/,
    },
    {
      name: "the devnet name aliased to the mainnet export at the runner's import",
      edits: [
        {
          file: RUNNER,
          from: "  USDC_MINT_DEVNET,\n  type SweepableWallet,",
          to: "  USDC_MINT_MAINNET as USDC_MINT_DEVNET,\n  type SweepableWallet,",
        },
      ],
      names: /USDC_MINT_DEVNET is bound to `USDC_MINT_MAINNET`/,
    },
    {
      name: "the runner's factory stops passing the allowlist",
      edits: [{ file: RUNNER, from: "    spendableMints: MOLECULE_SPENDABLE_MINTS,\n", to: "" }],
      names: /createSolanaWalletRail\( is not called with an object literal carrying/,
    },
    {
      name: "the allowlist overridden by a later spread",
      edits: [
        {
          file: RUNNER,
          from: "    spendableMints: MOLECULE_SPENDABLE_MINTS,\n",
          to: "    spendableMints: MOLECULE_SPENDABLE_MINTS,\n    ...(args as object),\n",
        },
      ],
      names: /createSolanaWalletRail\( is not called with an object literal carrying/,
    },
    {
      name: "the factory passes a different list",
      edits: [
        {
          file: RUNNER,
          from: "    spendableMints: MOLECULE_SPENDABLE_MINTS,\n",
          to: "    spendableMints: [...MOLECULE_SPENDABLE_MINTS, args.usdcMint ?? USDC_MINT_DEVNET],\n",
        },
      ],
      names: /createSolanaWalletRail\( is not called with an object literal carrying/,
    },
    {
      name: "the sweep rail built without the runner's factory",
      edits: [
        {
          file: RUNNER,
          from: "      createMoleculeWalletRail({\n        rpcUrl: sweepRpcUrl,",
          to: "      createSolanaWalletRail({\n        rpcUrl: sweepRpcUrl,",
        },
      ],
      names: /createSolanaWalletRail\( is not called with an object literal carrying/,
    },
    {
      name: "the money-execution boot check removed",
      edits: [
        {
          file: RUNNER,
          from: '  assertMoleculeRailContained(wallet, "money-execution");\n',
          to: "",
        },
      ],
      names: /defaultCreateMoneyRuntime has no UNCONDITIONAL assertMoleculeRailContained\(/,
    },
    // ── A check that exists but can be skipped is not a check. ──────────────
    {
      name: "the money-execution boot check made env-conditional (if)",
      edits: [
        {
          file: RUNNER,
          from: '  assertMoleculeRailContained(wallet, "money-execution");\n',
          to: '  if (process.env.X !== "1") assertMoleculeRailContained(wallet, "money-execution");\n',
        },
      ],
      names: /defaultCreateMoneyRuntime has no UNCONDITIONAL assertMoleculeRailContained\(/,
    },
    {
      name: "the earnings-sweep boot check behind a logical operator",
      edits: [
        {
          file: RUNNER,
          from: '    assertMoleculeRailContained(wallet, "earnings-sweep");\n',
          to: '    void (process.env.X !== "1" && assertMoleculeRailContained(wallet, "earnings-sweep"));\n',
        },
      ],
      names: /runMolecule has no UNCONDITIONAL assertMoleculeRailContained\(/,
    },
    {
      name: "the factory's boot check inside a ternary",
      edits: [
        {
          file: RUNNER,
          from: '  assertMoleculeRailContained(rail, "constructed");\n  return rail;',
          to: '  void (args.usdcMint ? assertMoleculeRailContained(rail, "constructed") : undefined);\n  return rail;',
        },
      ],
      names: /createMoleculeWalletRail has no UNCONDITIONAL assertMoleculeRailContained\(/,
    },
    {
      name: "the money-execution boot check in a try whose catch swallows it",
      edits: [
        {
          file: RUNNER,
          from: '  assertMoleculeRailContained(wallet, "money-execution");\n',
          to: '  try {\n    assertMoleculeRailContained(wallet, "money-execution");\n  } catch {\n    // swallowed\n  }\n',
        },
      ],
      names: /defaultCreateMoneyRuntime has no UNCONDITIONAL assertMoleculeRailContained\(/,
    },
    {
      name: "an early exit placed between obtaining the rail and checking it",
      edits: [
        {
          file: RUNNER,
          from: '  assertMoleculeRailContained(wallet, "money-execution");\n',
          to: '  if (process.env.X === "1") return undefined as never;\n  assertMoleculeRailContained(wallet, "money-execution");\n',
        },
      ],
      names: /defaultCreateMoneyRuntime has no UNCONDITIONAL assertMoleculeRailContained\(/,
    },
    // ── A second binding of the constant's name. ────────────────────────────
    {
      name: "a function parameter shadowing the constant builds a rail with another list",
      edits: [
        {
          file: RUNNER,
          from: '  assertMoleculeRailContained(rail, "constructed");\n  return rail;\n}\n',
          to:
            '  assertMoleculeRailContained(rail, "constructed");\n  return rail;\n}\n\n' +
            "export function widen(MOLECULE_SPENDABLE_MINTS: readonly string[]): SolanaWalletRail {\n" +
            "  return createSolanaWalletRail({\n" +
            '    rpcUrl: "x",\n' +
            "    identitySeed: new Uint8Array(32),\n" +
            "    spendableMints: MOLECULE_SPENDABLE_MINTS,\n" +
            "  });\n" +
            "}\n",
        },
      ],
      names: /MOLECULE_SPENDABLE_MINTS is bound a second time \(Parameter\)/,
    },
    {
      name: "a destructured local shadowing the constant",
      edits: [
        {
          file: RUNNER,
          from: '  assertMoleculeRailContained(rail, "constructed");\n  return rail;\n}\n',
          to:
            '  assertMoleculeRailContained(rail, "constructed");\n  return rail;\n}\n\n' +
            "export function widen2(env: { mints: readonly string[] }): readonly string[] {\n" +
            "  const { mints: MOLECULE_SPENDABLE_MINTS } = env;\n" +
            "  return MOLECULE_SPENDABLE_MINTS;\n" +
            "}\n",
        },
      ],
      names: /MOLECULE_SPENDABLE_MINTS is bound a second time \(BindingElement\)/,
    },
    {
      name: "the earnings-sweep boot check removed",
      edits: [
        {
          file: RUNNER,
          from: '    assertMoleculeRailContained(wallet, "earnings-sweep");\n',
          to: "",
        },
      ],
      names: /runMolecule has no UNCONDITIONAL assertMoleculeRailContained\(/,
    },
    {
      name: "the runner constructs a rail directly",
      edits: [
        {
          file: RUNNER,
          from: '  assertMoleculeRailContained(rail, "constructed");\n  return rail;',
          to: '  assertMoleculeRailContained(rail, "constructed");\n  return new SolanaWalletRail(undefined as never);',
        },
      ],
      names: /the runner constructs `new SolanaWalletRail\(` directly/,
    },
    {
      name: "the constant reassigned",
      edits: [
        {
          file: RUNNER,
          from: '  assertMoleculeRailContained(rail, "constructed");\n  return rail;',
          to: '  (MOLECULE_SPENDABLE_MINTS as string[])[1] = "x";\n  assertMoleculeRailContained(rail, "constructed");\n  return rail;',
        },
      ],
      names: /assignment to MOLECULE_SPENDABLE_MINTS/,
    },
    {
      name: "a molecule service imports the wallet package and builds its own rail",
      edits: [
        {
          file: SERVICE,
          from: SERVICE_IMPORT,
          to: `import { createSolanaWalletRail } from "@motebit/wallet-solana";\nvoid createSolanaWalletRail;\n${SERVICE_IMPORT}`,
        },
      ],
      names:
        /a molecule service (imports "@motebit\/wallet-solana"|names `createSolanaWalletRail`)/,
    },
    {
      name: "a molecule service passes the runner's money-runtime override",
      edits: [
        {
          file: SERVICE,
          from: SERVICE_IMPORT,
          to: `export const sideDoor = { createMoneyRuntime: () => null };\n${SERVICE_IMPORT}`,
        },
      ],
      names: /a molecule service names `createMoneyRuntime`/,
    },
    // ── The same override spelled as text, not as an identifier. ────────────
    {
      name: "a molecule service spells the override as a QUOTED property key",
      edits: [
        {
          file: SERVICE,
          from: SERVICE_IMPORT,
          to: `export const sideDoor = { "createMoneyRuntime": () => null };\n${SERVICE_IMPORT}`,
        },
      ],
      names: /a molecule service spells `createMoneyRuntime` as a string/,
    },
    {
      name: "a molecule service spells the override as a COMPUTED string key",
      edits: [
        {
          file: SERVICE,
          from: SERVICE_IMPORT,
          to: `export const sideDoor = { ["createSweepWallet"]: () => null };\n${SERVICE_IMPORT}`,
        },
      ],
      names: /a molecule service spells `createSweepWallet` as a string/,
    },
    {
      name: "a molecule service spells the override as a computed TEMPLATE key",
      edits: [
        {
          file: SERVICE,
          from: SERVICE_IMPORT,
          to: `export const sideDoor = { [\`createSweepWallet\`]: () => null };\n${SERVICE_IMPORT}`,
        },
      ],
      names: /a molecule service spells `createSweepWallet` as a string/,
    },
    {
      name: "a molecule service reaches the override by ELEMENT ACCESS",
      edits: [
        {
          file: SERVICE,
          from: SERVICE_IMPORT,
          to: `export const sideDoor: Record<string, unknown> = {};\nsideDoor["createMoneyRuntime"] = () => null;\n${SERVICE_IMPORT}`,
        },
      ],
      names: /a molecule service spells `createMoneyRuntime` as a string/,
    },
  ];

  it("documents what it still cannot see: a name assembled at run time passes, and the pass line says so", () => {
    const r = run(
      plantedTree([
        {
          file: SERVICE,
          from: SERVICE_IMPORT,
          to: `export const sideDoor = { ["create" + "SweepWallet"]: () => null };\n${SERVICE_IMPORT}`,
        },
      ]),
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("a forbidden name assembled at run time");
    expect(r.stdout).toContain("opaque runtime whose rail the runner cannot check");
  });

  // A plain loop (not it.each): each case's full name is then exact text a
  // tamper entry can name.
  for (const { name, edits, names } of PLANTED) {
    it(`fails on: ${name}`, () => {
      const r = run(plantedTree(edits));
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(names);
      // A failing gate teaches the repair: canonical source + directive.
      expect(hasRepairInstruction(r.stderr)).toEqual({ ok: true });
      expect(r.stderr).toContain("packages/molecule-runner/src/index.ts");
      expect(r.stderr).toContain("reviewed change");
    });
  }
});
