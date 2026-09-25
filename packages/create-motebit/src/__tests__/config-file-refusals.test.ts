// The refusal and edge paths of create-motebit's key-file helpers
// (docs/proposals/key-file-durability-v1.md). Every test asserts an outcome
// of R1 (absence is not damage), R2 (key bytes are never destroyed: kept, or
// the operation refuses with nothing changed) or R3 (owner-only, atomic,
// narrowed or reported).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    fchmodSync: vi.fn(actual.fchmodSync),
  };
});

const {
  ConfigDamagedError,
  identityFileMotebitId,
  moveAside,
  preserveAside,
  readConfigFile,
  replaceIdentityFile,
  withFileLock,
  writeConfigFile,
  writeFileAtomic,
} = await import("../config-file.js");
const { commitRotation, RotationCommitError } = await import("../rotate-commit.js");

const asRoot = process.getuid?.() === 0;
let dir: string;
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const NOW = new Date("2026-01-01T00:00:00.000Z");
const STAMP = "2026-01-01T00-00-00-000Z";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "create-motebit-refusals-"));
});
afterEach(() => {
  vi.mocked(fs.chmodSync).mockClear();
  vi.mocked(fs.fchmodSync).mockClear();
  // Undo any permission a test took away, so cleanup can see everything.
  for (const f of fs.readdirSync(dir)) {
    try {
      fs.chmodSync(path.join(dir, f), 0o700);
    } catch {
      /* a dangling link */
    }
  }
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("R1 — what is and is not absence", () => {
  it("a config path that is a DIRECTORY is damage (EISDIR), not a first run", () => {
    const p = path.join(dir, "config.json");
    fs.mkdirSync(p);
    expect(() => readConfigFile(p)).toThrow(ConfigDamagedError);
    expect(() => readConfigFile(p)).toThrow(/EISDIR/);
  });

  it("writeFileAtomic refuses a dangling symlink and leaves the link", () => {
    const link = path.join(dir, "config.json");
    fs.symlinkSync(path.join(dir, "unmounted", "config.json"), link);
    expect(() => writeFileAtomic(link, "{}", 0o600)).toThrow(/cannot be resolved/);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("moveAside of a name this process cannot even stat throws and leaves it in place", () => {
    if (asRoot) return;
    const sub = path.join(dir, "locked");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "pending-rotation.json"), "HELD");
    fs.chmodSync(sub, 0o000);
    expect(() => moveAside(path.join(sub, "pending-rotation.json"), ".clobbered-")).toThrow();
    fs.chmodSync(sub, 0o700);
    expect(fs.readFileSync(path.join(sub, "pending-rotation.json"), "utf-8")).toBe("HELD");
  });
});

describe("R2 — key bytes are kept, or nothing happens", () => {
  it("a declared change that replaces no identity material makes no copy", () => {
    const p = path.join(dir, "config.json");
    fs.writeFileSync(p, JSON.stringify({ motebit_id: "m", cli_encrypted_key: { c: "A" } }));
    const c = readConfigFile<Record<string, unknown>>(p);
    c["name"] = "renamed";
    expect(writeConfigFile(p, c, { identityChange: "preserve-replaced" })).toBeNull();
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });

  it("a declared change that replaces only the BINDING (motebit_id) keeps the old one", () => {
    const p = path.join(dir, "config.json");
    const body = JSON.stringify({ motebit_id: "m", device_public_key: "A" });
    fs.writeFileSync(p, body);
    const c = readConfigFile<Record<string, unknown>>(p);
    c["motebit_id"] = "m2";
    const kept = writeConfigFile(p, c, { identityChange: "preserve-replaced" });
    expect(fs.readFileSync(kept!, "utf-8")).toBe(body);
  });

  it("a backup name already taken is never overwritten: the next free name is used", () => {
    const p = path.join(dir, "config.json");
    fs.writeFileSync(p, "NEW BYTES");
    fs.writeFileSync(`${p}.clobbered-${STAMP}`, "EARLIER KEPT COPY");
    const kept = preserveAside(p, ".clobbered-", NOW);
    expect(kept).toBe(`${p}.clobbered-${STAMP}-1`);
    expect(fs.readFileSync(`${p}.clobbered-${STAMP}`, "utf-8")).toBe("EARLIER KEPT COPY");
    expect(fs.readFileSync(kept, "utf-8")).toBe("NEW BYTES");
  });

  it("moveAside never renames over an existing kept copy", () => {
    const p = path.join(dir, "pending-rotation.json");
    fs.writeFileSync(p, "HELD");
    fs.writeFileSync(`${p}.clobbered-${STAMP}`, "EARLIER");
    const kept = moveAside(p, ".clobbered-", NOW)!;
    expect(kept).toBe(`${p}.clobbered-${STAMP}-1`);
    expect(fs.readFileSync(`${p}.clobbered-${STAMP}`, "utf-8")).toBe("EARLIER");
  });

  it("moveAside refuses (name left in place) when every kept-copy name is taken", () => {
    const p = path.join(dir, "pending-rotation.json");
    fs.writeFileSync(p, "HELD");
    for (let n = 0; n < 100; n++) {
      fs.writeFileSync(`${p}.clobbered-${STAMP}${n === 0 ? "" : `-${n}`}`, "x");
    }
    expect(() => moveAside(p, ".clobbered-", NOW)).toThrow(/no.*free name|free name/);
    expect(fs.readFileSync(p, "utf-8")).toBe("HELD");
  });

  it("moveAside of a symlinked write-ahead keeps the TARGET's bytes and removes only the link", () => {
    const target = path.join(dir, "elsewhere.json");
    fs.writeFileSync(target, "TARGET BYTES");
    const link = path.join(dir, "pending-rotation.json");
    fs.symlinkSync(target, link);
    const kept = moveAside(link, ".clobbered-")!;
    expect(fs.readFileSync(kept, "utf-8")).toBe("TARGET BYTES");
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe("TARGET BYTES");
  });

  it("an UNREADABLE file is kept by hard link (its bytes survive the replace)", () => {
    if (asRoot) return;
    const p = path.join(dir, "config.json");
    fs.writeFileSync(p, "UNREADABLE KEY");
    fs.chmodSync(p, 0o000);
    const kept = preserveAside(p, ".clobbered-", NOW);
    expect(fs.statSync(kept).ino).toBe(fs.statSync(p).ino);
    fs.chmodSync(p, 0o600);
    expect(fs.readFileSync(kept, "utf-8")).toBe("UNREADABLE KEY");
  });

  it("an unreadable file whose first backup name is taken is linked under the next name", () => {
    if (asRoot) return;
    const p = path.join(dir, "config.json");
    fs.writeFileSync(p, "UNREADABLE KEY");
    fs.writeFileSync(`${p}.clobbered-${STAMP}`, "EARLIER");
    fs.chmodSync(p, 0o000);
    expect(preserveAside(p, ".clobbered-", NOW)).toBe(`${p}.clobbered-${STAMP}-1`);
    expect(fs.readFileSync(`${p}.clobbered-${STAMP}`, "utf-8")).toBe("EARLIER");
  });

  it("an unreadable file in a directory that cannot take a backup: preserve REFUSES", () => {
    if (asRoot) return;
    const p = path.join(dir, "config.json");
    fs.writeFileSync(p, "UNREADABLE KEY");
    fs.chmodSync(p, 0o000);
    fs.chmodSync(dir, 0o500);
    expect(() => preserveAside(p, ".clobbered-", NOW)).toThrow(/could not preserve/);
    fs.chmodSync(dir, 0o700);
  });

  it("preserving something that is not a file (a directory) or not there REFUSES", () => {
    expect(() => preserveAside(dir, ".clobbered-")).toThrow(/could not preserve/);
    expect(() => preserveAside(path.join(dir, "absent.json"), ".clobbered-")).toThrow(
      /could not resolve/,
    );
  });

  it("a copy that fails after it was created leaves no partial backup behind, and refuses", () => {
    const p = path.join(dir, "config.json");
    fs.writeFileSync(p, "KEY");
    vi.mocked(fs.fchmodSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    expect(() => preserveAside(p, ".clobbered-", NOW)).toThrow(/could not preserve/);
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });
});

describe("R3 — narrowing that cannot happen is SAID", () => {
  it("a world-readable config whose chmod fails still reads, and the exposure is reported", () => {
    const p = path.join(dir, "config.json");
    fs.writeFileSync(p, JSON.stringify({ a: 1 }));
    fs.chmodSync(p, 0o644);
    vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(readConfigFile<Record<string, unknown>>(p)["a"]).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toMatch(/readable by other users/);
  });
});

describe("the config lock", () => {
  it("a lock that cannot even be created (missing directory) refuses; the work never runs", () => {
    let ran = false;
    expect(() =>
      withFileLock(path.join(dir, "missing", "config.json"), () => {
        ran = true;
      }),
    ).toThrow();
    expect(ran).toBe(false);
  });

  it("a lock left by a dead process is broken", () => {
    const p = path.join(dir, "config.json");
    fs.writeFileSync(`${p}.lock`, "2147483646");
    expect(withFileLock(p, () => "ran")).toBe("ran");
    expect(fs.existsSync(`${p}.lock`)).toBe(false);
  });

  it("a lock naming no process but older than the stale window is broken", () => {
    const p = path.join(dir, "config.json");
    fs.writeFileSync(`${p}.lock`, "not-a-pid");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${p}.lock`, old, old);
    expect(withFileLock(p, () => "ran", { staleMs: 30_000 })).toBe("ran");
  });

  it("a lock held by a live process this user cannot signal (pid 1) is waited on, then refused", () => {
    if (asRoot) return;
    const p = path.join(dir, "config.json");
    fs.writeFileSync(`${p}.lock`, "1");
    expect(() => withFileLock(p, () => "ran", { timeoutMs: 60 })).toThrow(/locked/);
  });
});

describe("motebit.md — binding material", () => {
  const md = (id: string) => `---\nspec: motebit/identity@1.0\nmotebit_id: "${id}"\n---\n`;

  it("another identity's file is kept, byte for byte, before it is replaced", () => {
    const f = path.join(dir, "motebit.md");
    fs.writeFileSync(f, md("identity-A"));
    const kept = replaceIdentityFile(f, md("identity-B"))!;
    expect(fs.readFileSync(kept, "utf-8")).toBe(md("identity-A"));
    expect(fs.readFileSync(f, "utf-8")).toBe(md("identity-B"));
  });

  it("a newer signing of the SAME identity replaces it with no copy; a new file is 0644", () => {
    const f = path.join(dir, "motebit.md");
    expect(replaceIdentityFile(f, md("identity-A"))).toBeNull();
    expect(mode(f)).toBe(0o644);
    expect(replaceIdentityFile(f, md("identity-A") + "\n")).toBeNull();
    expect(replaceIdentityFile(f, md("identity-A") + "\n")).toBeNull(); // identical: no-op keep
  });

  it("a file whose identity cannot be told (no frontmatter, or unreadable) is kept", () => {
    const f = path.join(dir, "motebit.md");
    fs.writeFileSync(f, "not an identity file");
    expect(identityFileMotebitId("not an identity file")).toBeNull();
    expect(identityFileMotebitId("---\nname: x\n---\n")).toBeNull();
    expect(replaceIdentityFile(f, md("identity-B"))).not.toBeNull();
    if (asRoot) return;
    fs.chmodSync(f, 0o000);
    const kept = replaceIdentityFile(f, md("identity-C"));
    expect(kept).not.toBeNull();
  });

  it("a dangling symlinked motebit.md is not 'absent': it is refused, never replaced", () => {
    const f = path.join(dir, "motebit.md");
    fs.symlinkSync(path.join(dir, "gone.md"), f);
    expect(() => replaceIdentityFile(f, md("identity-B"))).toThrow();
    expect(fs.lstatSync(f).isSymbolicLink()).toBe(true);
  });
});

describe("create-motebit rotate commit failure points", () => {
  function plan() {
    const configPath = path.join(dir, "config.json");
    const identityPath = path.join(dir, "motebit.md");
    fs.writeFileSync(configPath, JSON.stringify({ cli_encrypted_key: "OLD_KEY" }));
    fs.writeFileSync(identityPath, "OLD_ID");
    return {
      configPath,
      identityPath,
      previousIdentity: "OLD_ID",
      nextIdentity: "NEW_ID",
      nextConfig: { cli_encrypted_key: "NEW_KEY" },
      now: NOW,
    };
  }

  it("the old key cannot be held (config gone): stops at hold-old, NOTHING names a new key", () => {
    const p = plan();
    fs.rmSync(p.configPath);
    let caught: unknown;
    try {
      commitRotation(p);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RotationCommitError);
    expect((caught as InstanceType<typeof RotationCommitError>).step).toBe("hold-old");
    expect(fs.readFileSync(p.identityPath, "utf-8")).toBe("OLD_ID");
    expect(fs.readdirSync(dir).filter((f) => f.includes("rotation-next"))).toEqual([]);
  });

  it("the new key cannot be held: stops at hold-new, config and identity still on the OLD key", () => {
    const p = plan();
    // Something already occupies the name the new key would be held under.
    fs.mkdirSync(`${p.configPath}.rotation-next-${STAMP}`);
    let caught: unknown;
    try {
      commitRotation(p);
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof RotationCommitError>).step).toBe("hold-new");
    expect(JSON.parse(fs.readFileSync(p.configPath, "utf-8")).cli_encrypted_key).toBe("OLD_KEY");
    expect(fs.readFileSync(p.identityPath, "utf-8")).toBe("OLD_ID");
    // The redundant old-key copy is dropped only because the config still holds it.
    expect(fs.readdirSync(dir).filter((f) => f.includes("pre-rotation"))).toEqual([]);
  });

  it("a failure that is not an Error still names the step and keeps both keys", () => {
    const p = plan();
    let caught: unknown;
    try {
      commitRotation(p, {
        writeBackup: () => {
          throw "disk full"; // eslint-disable-line @typescript-eslint/only-throw-error
        },
        writeIdentity: () => undefined,
        writeConfig: () => undefined,
      });
    } catch (err) {
      caught = err;
    }
    const e = caught as InstanceType<typeof RotationCommitError>;
    expect(e.message).toContain("disk full");
    expect(fs.readFileSync(e.oldKeyAt, "utf-8")).toContain("OLD_KEY");
    expect(fs.readFileSync(e.newKeyAt!, "utf-8")).toContain("NEW_KEY");
  });
});
