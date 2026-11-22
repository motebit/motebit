/**
 * check-runtime-single-relay-binding — real-repo smoke + planted breaks.
 *
 * Each planted case copies the runtime's non-test source and one surface
 * file into a temp tree, applies ONE edit that re-opens the class (a second
 * relay holder, in a shape main used or a near variant), and requires the
 * gate to fail naming it. If a rule is weakened, its planted case stops
 * failing and this goes red. These temp trees are the gate's own test
 * fixtures — the only thing its removed-names rule does not see in the repo.
 *
 * Design: runtime-relay-binding rev 6 §3.5 and section 5 ("Gate: green on
 * the branch, red on each planted shape").
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
const SCRIPT = resolve(ROOT, "scripts", "check-runtime-single-relay-binding.ts");
const TSX = resolve(ROOT, "node_modules", ".bin", "tsx");
const RT = "packages/runtime/src";
const SURFACE = "apps/web/src/web-app.ts";

// Each case type-checks the runtime's files in a fresh process.
vi.setConfig({ testTimeout: 120_000 });

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

type Edit = { file: string; from: string; to: string } | { file: string; append: string };

function plantedTree(edits: Edit[]): string {
  const dir = mkdtempSync(join(tmpdir(), "single-relay-binding-gate-"));
  temps.push(dir);
  cpSync(join(ROOT, RT), join(dir, RT), {
    recursive: true,
    filter: (src) => !src.includes("__tests__"),
  });
  mkdirSync(dirname(join(dir, SURFACE)), { recursive: true });
  cpSync(join(ROOT, SURFACE), join(dir, SURFACE));
  for (const e of edits) {
    const abs = join(dir, e.file);
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

const ID = `${RT}/interactive-delegation.ts`;
const IC = `${RT}/invoke-capability.ts`;
const MR = `${RT}/motebit-runtime.ts`;
const HF = `${RT}/hardware-attestation-fetcher.ts`;

describe("check-runtime-single-relay-binding", () => {
  it("passes on the repo and states what it read", () => {
    const r = run();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("check-runtime-single-relay-binding");
    expect(r.stdout).toMatch(/T2 read \d+ typed declaration/);
    expect(r.stdout).toMatch(/T3 scanned \d+ /);
    expect(r.stdout).toContain("NOT CAUGHT");
    expect(hasApertureDisclosure(r.stdout).ok).toBe(true);
  });

  it("passes on an unedited copy (the planted tree itself is sound)", () => {
    const r = run(plantedTree([]));
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  it("T1: a config type regaining syncUrl", () => {
    expectFails(
      [
        {
          file: ID,
          from: "export interface InteractiveDelegationConfig {",
          to: "export interface InteractiveDelegationConfig {\n  syncUrl: string;",
        },
      ],
      "T1: `InteractiveDelegationConfig` has relay member(s) syncUrl",
    );
  });

  it("T1: the fetcher config regaining baseUrl", () => {
    expectFails(
      [
        {
          file: HF,
          from: "export interface RelayCapabilitiesFetcherConfig {",
          to: "export interface RelayCapabilitiesFetcherConfig {\n  readonly baseUrl?: string;",
        },
      ],
      "T1: `RelayCapabilitiesFetcherConfig` has relay member(s) baseUrl",
    );
  });

  it("T1: main's enable(config) shape under a new type name (a method parameter)", () => {
    expectFails(
      [
        {
          file: ID,
          from: "  unregister(): void {",
          to: "  adopt(relay: { syncUrl: string; authToken: () => Promise<string> }): void {\n    void relay;\n  }\n\n  unregister(): void {",
        },
      ],
      /T1: InteractiveDelegationManager method adopt parameter `relay` has relay member\(s\) syncUrl, authToken/,
    );
  });

  it("T1: a manager constructor taking a relay config again", () => {
    expectFails(
      [
        {
          file: IC,
          from: "    private readonly getBinding: RelayBindingSource,\n  ) {}",
          to: "    private readonly getBinding: RelayBindingSource,\n    private readonly config?: { relayPublicKey: string },\n  ) {}",
        },
      ],
      /T1: InvokeCapabilityManager constructor parameter `config` has relay member\(s\) relayPublicKey/,
    );
  });

  it('T2: a Pick<SubmitAndPollParams, "syncUrl"> class field', () => {
    expectFails(
      [
        {
          file: ID,
          from: "export class InteractiveDelegationManager {",
          to: 'export class InteractiveDelegationManager {\n  private lastRelay: Pick<import("./relay-delegation.js").SubmitAndPollParams, "syncUrl"> | null = null;',
        },
      ],
      /T2: InteractiveDelegationManager property `lastRelay` holds relay member\(s\) syncUrl/,
    );
  });

  it("T2: a module `let` holding a config", () => {
    expectFails(
      [
        {
          file: IC,
          append:
            "// planted\nexport let lastTapRelay: { syncUrl: string; authToken: () => Promise<string> } | undefined;",
        },
      ],
      /T2: module variable `lastTapRelay` holds relay member\(s\) syncUrl, authToken/,
    );
  });

  it("T2: a second runtime field holding the binding's type (main's granted-spend coordinates)", () => {
    expectFails(
      [
        {
          file: MR,
          from: "  private _relayGeneration = 0;",
          to: '  private _relayGeneration = 0;\n  private _grantedSpend: Pick<RelayBinding, "syncUrl" | "relayPublicKey"> | null = null;',
        },
      ],
      /T2: MotebitRuntime property `_grantedSpend` holds relay member\(s\) syncUrl, relayPublicKey/,
    );
  });

  it("T2: an array of relay-shaped elements is NOT entered (the mcpConfigs exclusion by traversal)", () => {
    const r = run(
      plantedTree([
        {
          file: MR,
          from: "  private _relayGeneration = 0;",
          to: "  private _relayGeneration = 0;\n  private _plantedServers: Array<{ authToken: string }> = [];",
        },
      ]),
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  it("T3: a removed-API call in a surface", () => {
    expectFails(
      [
        {
          file: SURFACE,
          append:
            "export function __planted(r: { enableInvokeCapability(c: unknown): void }): void {\n  r.enableInvokeCapability({});\n}",
        },
      ],
      /apps\/web\/src\/web-app\.ts:\d+ — T3: calls the removed `enableInvokeCapability`/,
    );
  });

  it("T3: a removed-API call through an element access", () => {
    expectFails(
      [
        {
          file: SURFACE,
          append:
            'export function __planted(r: Record<string, () => void>): void {\n  r["disableInteractiveDelegation"]!();\n}',
        },
      ],
      "T3: calls the removed `disableInteractiveDelegation`",
    );
  });

  it("T3: a string that only names a removed API is not a call", () => {
    const r = run(
      plantedTree([
        {
          file: SURFACE,
          append: 'export const __note = "enableInteractiveDelegation was removed";',
        },
      ]),
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  it("T4: a manager class renamed away", () => {
    expectFails(
      [
        {
          file: IC,
          from: "export class InvokeCapabilityManager {",
          to: "export class TapManager {",
        },
      ],
      "class `InvokeCapabilityManager` is missing (T4 presence)",
    );
  });

  it("T4: the binding field renamed (it is then an ordinary holder)", () => {
    expectFails(
      [
        {
          file: MR,
          from: "  private _relayBinding: RelayBindingSnapshot | null = null;",
          to: "  private _relayBindingRenamed: RelayBindingSnapshot | null = null;",
        },
      ],
      /T2: MotebitRuntime property `_relayBindingRenamed` holds relay member\(s\)/,
    );
  });
});
