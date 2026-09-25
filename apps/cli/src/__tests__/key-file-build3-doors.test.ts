// Key-file durability build 3 (docs/proposals/key-file-durability-v1.md),
// the CLI's other doors onto key or identity-binding files:
//
//  - item 12  `motebit init --file <key file> --force` refuses
//  - item 13  the smoke-x402 EVM key files (may hold funds)
//  - item 14  `motebit relay up`'s database (a plaintext relay key by default)
//  - item 31/X12  motebit.md: another identity's file is kept, never overwritten

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isKeyBearingFile, replaceIdentityFile } from "../durable-file.js";
import { loadOrCreateEoaKeyFile } from "../subcommands/smoke-x402.js";
import { secureRelayDbFiles } from "../subcommands/relay.js";
import { handleInit } from "../subcommands/init.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-kf3-doors-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe("item 12 — `motebit init --force` never writes over a key file", () => {
  it.each([
    "config.json",
    "pending-rotation.json",
    "dev-keyring.json",
    "config.json.clobbered-2026-01-01T00-00-00-000Z",
    "motebit.md",
  ])("refuses %s, forced or not, and leaves it untouched", (name) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, "KEY BYTES");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("EXIT");
    });
    expect(() => handleInit({ file: target, force: true } as never)).toThrow("EXIT");
    expect(fs.readFileSync(target, "utf-8")).toBe("KEY BYTES");
  });

  it("follows a symlink to judge the file it names", () => {
    const real = path.join(dir, "config.json");
    fs.writeFileSync(real, "{}");
    const link = path.join(dir, "innocent.yaml");
    fs.symlinkSync(real, link);
    expect(isKeyBearingFile(link)).toBe(true);
    expect(isKeyBearingFile(path.join(dir, "motebit.yaml"))).toBe(false);
  });
});

describe("item 13 — the smoke-x402 EVM key files", () => {
  const KEY = `0x${"ab".repeat(32)}`;
  it("absent ⇒ a new key, written atomically 0600 in an owner-only directory", () => {
    const f = path.join(dir, "sub", "smoke-x402-buyer-eoa.txt");
    const r = loadOrCreateEoaKeyFile(f, () => KEY);
    expect(r).toEqual({ key: KEY, justGenerated: true });
    expect(mode(f)).toBe(0o600);
    expect(mode(path.dirname(f))).toBe(0o700);
  });

  it("a file that does not hold a valid key is REFUSED and left untouched — never regenerated over", () => {
    const f = path.join(dir, "smoke-x402-buyer-eoa.txt");
    fs.writeFileSync(f, "0xdeadbeef-truncated");
    expect(() => loadOrCreateEoaKeyFile(f, () => KEY)).toThrow(/left untouched/);
    expect(fs.readFileSync(f, "utf-8")).toBe("0xdeadbeef-truncated");
  });

  it("a dangling symlink is damage, not absence: refused, nothing generated", () => {
    const f = path.join(dir, "smoke-x402-buyer-eoa.txt");
    fs.symlinkSync(path.join(dir, "unmounted", "key.txt"), f);
    let generated = false;
    expect(() =>
      loadOrCreateEoaKeyFile(f, () => {
        generated = true;
        return KEY;
      }),
    ).toThrow(/could not be read/);
    expect(generated).toBe(false);
    expect(fs.lstatSync(f).isSymbolicLink()).toBe(true);
  });

  it("a world-readable key is narrowed to 0600 on load", () => {
    const f = path.join(dir, "smoke-x402-worker-eoa.txt");
    fs.writeFileSync(f, KEY);
    fs.chmodSync(f, 0o644);
    expect(loadOrCreateEoaKeyFile(f, () => "unused").key).toBe(KEY);
    expect(mode(f)).toBe(0o600);
  });
});

describe("item 14 — the relay database (the relay's private key, plaintext by default)", () => {
  it("a new database is created EMPTY and 0600 before SQLite opens it", () => {
    const db = path.join(dir, "relay.db");
    const prev = process.umask(0o022);
    try {
      secureRelayDbFiles(db);
    } finally {
      process.umask(prev);
    }
    expect(fs.statSync(db).size).toBe(0);
    expect(mode(db)).toBe(0o600);
  });

  it("an existing database and its journal files are narrowed to 0600", () => {
    const db = path.join(dir, "relay.db");
    for (const f of [db, `${db}-wal`, `${db}-shm`]) {
      fs.writeFileSync(f, "x");
      fs.chmodSync(f, 0o644);
    }
    secureRelayDbFiles(db);
    for (const f of [db, `${db}-wal`, `${db}-shm`]) expect(mode(f)).toBe(0o600);
  });
});

describe("X12 — motebit.md: another identity's signed file is kept, never overwritten", () => {
  const md = (id: string, extra = "") =>
    `---\nspec: motebit/identity@1.0\nmotebit_id: "${id}"\n${extra}---\n\n<!-- motebit:sig:x -->\n`;

  it("a different identity's file is kept as motebit.md.clobbered-*, byte for byte", () => {
    const f = path.join(dir, "motebit.md");
    fs.writeFileSync(f, md("identity-A"));
    const kept = replaceIdentityFile(f, md("identity-B"));
    expect(kept).not.toBeNull();
    expect(fs.readFileSync(kept!, "utf-8")).toBe(md("identity-A"));
    expect(fs.readFileSync(f, "utf-8")).toBe(md("identity-B"));
  });

  it("a newer signing of the SAME identity replaces it without a copy", () => {
    const f = path.join(dir, "motebit.md");
    fs.writeFileSync(f, md("identity-A"));
    expect(replaceIdentityFile(f, md("identity-A", "name: renamed\n"))).toBeNull();
  });

  it("an unparseable file (whose identity cannot be told) is kept", () => {
    const f = path.join(dir, "motebit.md");
    fs.writeFileSync(f, "not an identity file");
    expect(replaceIdentityFile(f, md("identity-B"))).not.toBeNull();
  });
});

describe("item 16 — every creation of the motebit state directory is owner-only", () => {
  it("no CLI source creates a directory except through mkdirOwnerOnly (the user-chosen export dir excepted)", () => {
    const src = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(p);
        } else if (p.endsWith(".ts") && !p.endsWith("durable-file.ts")) {
          if (/\bmkdirSync\(/.test(fs.readFileSync(p, "utf-8"))) {
            const rel = path.relative(src, p);
            // export writes the user's chosen --output directory, not ~/.motebit.
            if (rel !== path.join("subcommands", "export.ts")) offenders.push(rel);
          }
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
