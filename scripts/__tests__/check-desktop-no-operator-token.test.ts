/**
 * check-desktop-no-operator-token — real-repo smoke + planted breaks (design
 * 2026-11-20, test 5).
 *
 * Each planted case copies the desktop's non-test source (apps/desktop/src and
 * apps/desktop/src-tauri/src) into a temp tree, applies ONE edit that names
 * the relay operator token again, and requires the gate to fail naming it.
 * If someone weakens the rule, its planted case stops failing and this goes
 * red. The stated blind spot (a key built at run time) is planted too, and
 * the gate is required to stay GREEN on it: that hole is held by the shared
 * key-store stand-in, apps/desktop/src/__tests__/operator-slot-guard.ts.
 *
 * Tamper: scripts/tampers/desktop-no-operator-token.ts
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
const SCRIPT = resolve(ROOT, "scripts", "check-desktop-no-operator-token.ts");
const TSX = resolve(ROOT, "node_modules", ".bin", "tsx");
const TREES = ["apps/desktop/src", "apps/desktop/src-tauri/src"];

// Every case spawns the gate: about a second each when idle, several when the
// machine is loaded (the tamper runner runs many copies at once).
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
  | { file: string; create: string }
  | { remove: string };

/** A copy of the desktop's source (tests left out), with `edits` applied. */
function plantedTree(edits: Edit[]): string {
  const dir = mkdtempSync(join(tmpdir(), "desktop-operator-token-gate-"));
  temps.push(dir);
  for (const t of TREES) {
    cpSync(join(ROOT, t), join(dir, t), {
      recursive: true,
      filter: (src) => !src.includes("__tests__"),
    });
  }
  for (const e of edits) {
    if ("remove" in e) {
      rmSync(join(dir, e.remove), { recursive: true, force: true });
      continue;
    }
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

function expectPasses(edits: Edit[]): string {
  const r = run(plantedTree(edits));
  const out = `${r.stdout}${r.stderr}`;
  expect(r.status, out).toBe(0);
  return out;
}

const CONFIG = "apps/desktop/src/ui/config.ts";
const MAIN = "apps/desktop/src/main.ts";
const STARTUP = "apps/desktop/src/sync-startup.ts";
const CONTROLLER = "apps/desktop/src/sync-controller.ts";
const RUST = "apps/desktop/src-tauri/src/main.rs";

describe("check-desktop-no-operator-token", () => {
  it("passes on the repo and states what it scanned and what it cannot see", () => {
    const r = run();
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).toMatch(
      /\d+ source file\(s\) scanned under apps\/desktop\/src and apps\/desktop\/src-tauri\/src/,
    );
    expect(out).toMatch(/\d+ TypeScript\/JavaScript, \d+ Rust/);
    expect(hasApertureDisclosure(out).ok, out).toBe(true);
    expect(out).toContain("NOT CAUGHT: (1) a key-store key assembled at run time");
    expect(out).toContain("(2) a read of the slot from inside a package");
  });

  it("an unedited copy passes (the planting harness itself is clean)", () => {
    expectPasses([]);
  });

  describe("the operator token named again", () => {
    it("a key-store read of the slot by name", () => {
      expectFails(
        [
          {
            file: CONFIG,
            from: "    const syncUrl = (parsed.sync_url as string | undefined) ?? undefined;\n",
            to: '    const syncUrl = (parsed.sync_url as string | undefined) ?? undefined;\n    void invoke("keyring_get", { key: "sync_master_token" });\n',
          },
        ],
        `${CONFIG}:`,
      );
    });

    it("the constant for the slot", () => {
      expectFails(
        [
          {
            file: "apps/desktop/src/ui/keyring-keys.ts",
            append: 'export const SYNC_MASTER_TOKEN_SLOT = "sync" + "_token";',
          },
        ],
        "the identifier `SYNC_MASTER_TOKEN_SLOT`",
      );
    });

    it("the config field", () => {
      expectFails(
        [
          {
            file: "apps/desktop/src/index.ts",
            from: "  syncUrl?: string;\n",
            to: "  syncUrl?: string;\n  syncMasterToken?: string;\n",
          },
        ],
        "the identifier `syncMasterToken`",
      );
    });

    it("a parameter on the startup sequence", () => {
      expectFails(
        [
          {
            file: STARTUP,
            from: "  syncUrl: string,\n  onFailure:",
            to: "  syncUrl: string,\n  masterToken: string | undefined,\n  onFailure:",
          },
        ],
        "the identifier `masterToken`",
      );
    });

    it("the word in any case, in an identifier", () => {
      expectFails(
        [{ file: CONTROLLER, append: "export const RelayMASTERKey = 1;" }],
        "the identifier `RelayMASTERKey`",
      );
    });

    it("the word in a template literal", () => {
      expectFails(
        [{ file: CONTROLLER, append: "export const slot = (p: string) => `${p}_Master_token`;" }],
        /R1 the text .*Master_token.* in a string/,
      );
    });

    it("the word spelled through an escape", () => {
      expectFails(
        [{ file: CONTROLLER, append: 'export const slot = "sync_\\u006daster_token";' }],
        /R1 the text "sync_master_token" in a string/,
      );
    });

    it("a file in a directory other than __tests__ is scanned (a __fixtures__ copy)", () => {
      expectFails(
        [
          {
            file: "apps/desktop/src/__fixtures__/reader.ts",
            create: 'export const k = "sync_master_token";\n',
          },
        ],
        "apps/desktop/src/__fixtures__/reader.ts:1",
      );
    });

    it("a file of another type is read as raw text, comments included", () => {
      expectFails(
        [
          {
            file: "apps/desktop/src/ui/slots.json",
            create: '{ "operator": "sync_master_token" }\n',
          },
        ],
        "apps/desktop/src/ui/slots.json:1 — R1 in a file read as raw text",
      );
    });
  });

  describe("main.ts, which no test can import, is held here", () => {
    it("startup sync handed a slot read", () => {
      expectFails(
        [
          {
            file: MAIN,
            from: "    void trySyncRegistration(config.invoke, config.syncUrl);\n",
            to: '    void trySyncRegistration(config.invoke, config.syncUrl);\n    void config.invoke("keyring_get", { key: "sync_master_token" });\n',
          },
        ],
        `${MAIN}:`,
      );
    });

    it("Connect handed a slot read as the socket bearer", () => {
      expectFails(
        [
          {
            file: MAIN,
            from: "        await ctx.app.startSync(invokeFn, url);\n",
            to: '        const masterToken = await invokeFn<string | null>("keyring_get", { key: "sync_" + "token" });\n        await ctx.app.startSync(invokeFn, url, masterToken ?? undefined);\n',
          },
        ],
        "the identifier `masterToken`",
      );
    });
  });

  describe("Rust", () => {
    it("a string naming the slot fails", () => {
      expectFails(
        [{ file: RUST, append: 'const OPERATOR_SLOT: &str = "sync_master_token";' }],
        `${RUST}:`,
      );
    });

    it("a comment marker inside a string does not hide the word", () => {
      expectFails([{ file: RUST, append: 'const S: &str = "// sync_master_token";' }], `${RUST}:`);
    });

    it("a raw string naming the slot fails", () => {
      expectFails([{ file: RUST, append: 'const S: &str = r#"sync_master_token"#;' }], `${RUST}:`);
    });

    it("a comment may say what was removed (line and block)", () => {
      expectPasses([
        {
          file: RUST,
          append:
            "// The relay operator (master) token is not read here.\n/* nor the sync_master_token slot /* nested */ */\nconst _LIFETIME_OK: Option<&'static str> = None;",
        },
      ]);
    });
  });

  it("a TypeScript comment may say what was removed", () => {
    expectPasses([
      {
        file: CONTROLLER,
        append: "// The sync_master_token slot is not read (syncMasterToken was removed).\n",
      },
    ]);
  });

  it("R2 — a production file importing from __tests__ fails", () => {
    expectFails(
      [{ file: CONTROLLER, append: 'export * from "./__tests__/operator-slot-guard";' }],
      /R2 names "\.\/__tests__\/operator-slot-guard"/,
    );
  });

  it("a scanned tree that moved fails", () => {
    expectFails([{ remove: "apps/desktop/src-tauri/src" }], "a scanned tree does not exist");
  });

  it("stays GREEN on its stated blind spot: a key built at run time (held by operator-slot-guard.ts)", () => {
    expectPasses([
      {
        file: CONTROLLER,
        append:
          'export const readSlot = (invoke: (c: string, a: object) => Promise<unknown>) =>\n  invoke("keyring_get", { key: ["sync", "mas" + "ter", "token"].join("_") });',
      },
    ]);
  });
});
