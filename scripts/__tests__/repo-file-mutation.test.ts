/**
 * The gate self-test lock's liveness and crash recovery
 * (`repo-file-mutation.ts`), deterministically, on a PRIVATE lock directory
 * (`MOTEBIT_GATE_LOCK_DIR`) and scratch files outside the repo — the real
 * lock other gate self-tests share is never touched. (The cross-process
 * races and kill -9 probes live in `repo-lock.harness.ts`.)
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const SCRATCH = mkdtempSync(join(tmpdir(), "motebit-lock-test-"));
const LOCK = join(SCRATCH, "lock");
process.env.MOTEBIT_GATE_LOCK_DIR = LOCK;
// A starved acquirer fails fast instead of at the 25 s default.
process.env.MOTEBIT_GATE_LOCK_WAIT_MS = "4000";
const { withRepoLock } = await import("./repo-file-mutation.ts");

const blobHash = (b: Buffer): string =>
  createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

/** A dead pid: above any default pid_max, so nothing can be running as it. */
const DEAD_OWNER = { pid: 4_194_303 + 1_000, start: null, token: "dead", since: "then" };

beforeEach(() => {
  rmSync(LOCK, { recursive: true, force: true });
  mkdirSync(LOCK, { recursive: true });
});
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  delete process.env.MOTEBIT_GATE_LOCK_DIR;
  delete process.env.MOTEBIT_GATE_LOCK_WAIT_MS;
});

async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("lock liveness: a waiter killed mid-ticket-write", () => {
  it("an empty t-*.tmp left behind is not the queue's head — acquire succeeds promptly", async () => {
    // What `writeAtomic` leaves when kill -9 lands between create and rename:
    // an empty `<ticket>.<hex>.tmp`, sorting before every live ticket.
    writeFileSync(join(LOCK, "t-00000000000000001-deadbeefdeadbeef.0123456789ab.tmp"), "");
    await expect(
      within(
        2_000,
        withRepoLock(() => "held"),
      ),
    ).resolves.toBe("held");
  });

  it("an old one is swept as crash debris by the next holder", async () => {
    const stale = join(LOCK, "t-00000000000000001-deadbeefdeadbeef.0123456789ab.tmp");
    writeFileSync(stale, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old);
    await withRepoLock(() => undefined);
    expect(existsSync(stale)).toBe(false);
  });
});

describe("crash recovery restores only the bytes it perturbed", () => {
  const HEAD = Buffer.from("export const original = 1;\n");
  const PERTURBED = Buffer.from("// perturbed by a gate self-test\n");

  /** A generation whose owner died mid-perturbation of `file`. */
  function plantCrash(file: string): void {
    const backupDir = mkdtempSync(join(SCRATCH, "backup-"));
    const backup = join(backupDir, "f.ts");
    writeFileSync(backup, HEAD);
    const gen = join(LOCK, "g1");
    mkdirSync(gen);
    writeFileSync(join(gen, "owner"), JSON.stringify(DEAD_OWNER));
    writeFileSync(
      join(gen, "manifest.json"),
      JSON.stringify({
        entries: [{ rel: file, backup, blob: blobHash(HEAD), perturbed: blobHash(PERTURBED) }],
      }),
    );
  }

  it("the file still holds the perturbed bytes: restored to HEAD, the crashed generation gone", async () => {
    const file = join(SCRATCH, "perturbed.ts");
    writeFileSync(file, PERTURBED);
    plantCrash(file);
    await withRepoLock(() => undefined);
    expect(readFileSync(file).equals(HEAD)).toBe(true);
    expect(readdirSync(LOCK).includes("g1")).toBe(false);
  });

  it("the file was edited since the crash: refused loudly, naming it, and the edit kept", async () => {
    const file = join(SCRATCH, "edited.ts");
    const EDIT = Buffer.from("export const original = 2; // the developer's edit\n");
    writeFileSync(file, EDIT);
    plantCrash(file);
    await expect(withRepoLock(() => undefined)).rejects.toThrow(
      new RegExp(`refused to restore ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*edited since`),
    );
    expect(readFileSync(file).equals(EDIT)).toBe(true);
  });
});
