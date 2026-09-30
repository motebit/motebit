/**
 * Harness for the gate-self-test lock and its crash recovery
 * (`repo-file-mutation.ts`). NOT a vitest file — it races, kills and times
 * real processes, and it owns this checkout's lock while it runs, so run it
 * ALONE (no `test:gates` in the same checkout at the same time):
 *
 *   npx tsx scripts/__tests__/repo-lock.harness.ts [h1|h2|h4|all] [trials=20]
 *
 * Every client is a `repo-lock.driver.ts` child, so the same harness measures
 * the synchronous lock of 48f1547 and the async one after it.
 *
 *  H1  stale-lock exclusivity. A holder is SIGKILLed inside the lock (a dead
 *      owner) — and, in the `reuse` variant, its owner record is re-pointed at
 *      a LIVE pid that is not the process that took the lock (PID reuse) —
 *      then 8 clients, released together from a start barrier, race to
 *      acquire. Each claims `inside` with O_EXCL while
 *      it holds; an EEXIST, or overlapping enter/exit intervals, is two
 *      holders at once. Green = every trial 8/8 finished, 0 overlaps.
 *      48f1547 broke a stale lock by check-then-`rmSync`, so a client that
 *      judged the dead owner could delete the lock a faster client had just
 *      re-taken (up to 7 holders at once), and a live reused pid made the
 *      stale lock look held for the full 10-minute wait.
 *  H2  kill -9 mid-perturbation. A client perturbing identity-transparency.ts
 *      is SIGKILLed; the next run (the driver, then the real
 *      check-spec-routes self-test) must leave the file byte-identical to
 *      HEAD. Then the lockless variant: the file is corrupted with no lock
 *      state at all, and the next run must REFUSE, naming the restore
 *      command — never back up the corrupted bytes as the "original" and
 *      verify its own restore of them (what 48f1547 did).
 *  H4  PID reuse: a lock owned by a live pid whose start time does not match
 *      the owner record is judged stale promptly (< 5 s), not waited out.
 *
 * The harness restores identity-transparency.ts from HEAD whatever happens,
 * and says so if it had to.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = resolve(ROOT, "scripts", "__tests__", "repo-lock.driver.ts");
const LOCK = join(
  tmpdir(),
  `motebit-gate-self-test-lock-${createHash("sha256").update(ROOT).digest("hex").slice(0, 12)}`,
);
const REL = "services/relay/src/identity-transparency.ts";
const TARGET = resolve(ROOT, REL);
const HEAD_BYTES = spawnSync("git", ["show", `HEAD:${REL}`], { cwd: ROOT }).stdout as Buffer;

const [which = "all", trialsArg = "20"] = process.argv.slice(2);
const TRIALS = Number(trialsArg);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  ms: number;
  timedOut: boolean;
}

function driver(args: string[]): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", DRIVER, ...args], { cwd: ROOT });
}

function finish(child: ChildProcess, timeoutMs: number): Promise<Exit> {
  const t0 = Date.now();
  return new Promise((done) => {
    let out = "";
    let timedOut = false;
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, out, ms: Date.now() - t0, timedOut });
    });
  });
}

async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

/**
 * Leave a lock held by a SIGKILLed client — in whatever on-disk format the
 * module under test writes, because the client wrote it. `perturb` kills it
 * mid-perturbation instead of mid-hold.
 */
async function killInsideLock(perturb = false): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "motebit-lock-harness-"));
  const ready = join(dir, "ready");
  const child = driver([perturb ? "perturb-forever" : "hold-forever", ready]);
  const exited = finish(child, 120_000);
  if (!(await until(() => existsSync(ready), 60_000))) {
    child.kill("SIGKILL");
    throw new Error(`client never entered the lock: ${(await exited).out}`);
  }
  child.kill("SIGKILL");
  await exited; // reaped: not a zombie that `kill(pid, 0)` still finds
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Re-point every live owner record at `pid` — a process that is alive but is
 * not the one that took the lock: PID reuse. Knows both on-disk formats: the
 * 48f1547 `<lock>/owner` (a bare pid) and the generation dirs after it
 * (`<lock>/g<N>/owner`, JSON with pid + start time; `released` = free).
 */
function fakePidReuse(pid: number): number {
  let n = 0;
  const flat = join(LOCK, "owner");
  if (existsSync(flat) && /^\d+$/.test(readFileSync(flat, "utf8").trim())) {
    writeFileSync(flat, String(pid));
    return 1;
  }
  for (const e of existsSync(LOCK) ? readdirSync(LOCK) : []) {
    const owner = join(LOCK, e, "owner");
    if (!/^g\d+$/.test(e) || !existsSync(owner) || existsSync(join(LOCK, e, "released"))) continue;
    const rec = JSON.parse(readFileSync(owner, "utf8")) as { pid: number };
    rec.pid = pid;
    writeFileSync(owner, JSON.stringify(rec));
    n++;
  }
  return n;
}

function resetLock(): void {
  rmSync(LOCK, { recursive: true, force: true });
}

function targetAtHead(): boolean {
  return readFileSync(TARGET).equals(HEAD_BYTES);
}

function restoreTarget(): boolean {
  if (targetAtHead()) return false;
  writeFileSync(TARGET, HEAD_BYTES);
  return true;
}

const results: { name: string; green: boolean; detail: string }[] = [];
function record(name: string, green: boolean, detail: string): void {
  results.push({ name, green, detail });
  console.log(`${green ? "GREEN" : "RED  "} ${name}: ${detail}`);
}

// ── H1 ─────────────────────────────────────────────────────────────────────

async function h1Trial(reuse: boolean): Promise<{ ok: boolean; why: string }> {
  await killInsideLock();
  if (reuse && fakePidReuse(process.pid) === 0) return { ok: false, why: "no owner record" };
  const dir = mkdtempSync(join(tmpdir(), "motebit-lock-harness-"));
  writeFileSync(join(dir, "log"), "");
  const running = Array.from({ length: 8 }, () => finish(driver(["hold", dir, "100"]), 30_000));
  // Start barrier: every client is loaded and spinning before any may try.
  await until(() => readdirSync(dir).filter((f) => f.startsWith("ready-")).length === 8, 30_000);
  writeFileSync(join(dir, "go"), "");
  const exits = await Promise.all(running);
  const lines = readFileSync(join(dir, "log"), "utf8").trim().split("\n").filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  const intervals = new Map<string, [number, number]>();
  let overlaps = lines.filter((l) => l.endsWith("OVERLAP")).length;
  for (const l of lines) {
    const [kind, pid, t] = l.split(" ");
    const iv = intervals.get(pid!) ?? [NaN, NaN];
    iv[kind === "enter" ? 0 : 1] = Number(t);
    intervals.set(pid!, iv);
  }
  const ivs = [...intervals.values()].sort((x, y) => x[0] - y[0]);
  let maxConcurrent = 1;
  for (let i = 0; i < ivs.length; i++) {
    const c = ivs.filter((iv) => iv[0] < ivs[i]![1] && iv[1] > ivs[i]![0]).length;
    maxConcurrent = Math.max(maxConcurrent, c);
    if (c > 1) overlaps++;
  }
  const done = exits.filter((e) => e.code === 0).length;
  const timedOut = exits.filter((e) => e.timedOut).length;
  if (timedOut > 0 || done < 8) resetLock(); // a stuck lock would poison the next trial
  const ok = done === 8 && overlaps === 0;
  const err = exits
    .find((e) => e.code !== 0 && !e.timedOut)
    ?.out.trim()
    .split("\n")[0];
  return {
    ok,
    why:
      `${done}/8 done, ${timedOut} timed out (30s), max ${maxConcurrent} holders at once` +
      (err ? ` [${err.slice(0, 120)}]` : ""),
  };
}

async function h1(): Promise<void> {
  for (const reuse of [false, true]) {
    const name = `H1 ${reuse ? "live-pid-reuse" : "dead-owner"} stale lock, 8 waiters`;
    // A lock that never breaks times every trial out at 30 s; cap the damage.
    const trials = reuse ? Math.min(TRIALS, Number(process.env.H1_REUSE_TRIALS ?? TRIALS)) : TRIALS;
    if (trials === 0) continue;
    let exclusive = 0;
    const bad: string[] = [];
    for (let t = 0; t < trials; t++) {
      const r = await h1Trial(reuse);
      if (r.ok) exclusive++;
      else bad.push(`#${t}: ${r.why}`);
    }
    record(
      name,
      exclusive === trials,
      `${exclusive}/${trials} exclusive ${bad.slice(0, 4).join("; ")}`,
    );
  }
}

// ── H2 ─────────────────────────────────────────────────────────────────────

async function h2(): Promise<void> {
  if (!targetAtHead())
    throw new Error(`${REL} differs from HEAD before H2 — git checkout HEAD -- ${REL}`);
  for (const next of ["driver", "check-spec-routes self-test"] as const) {
    const name = `H2 kill -9 mid-perturbation, next run = ${next}`;
    try {
      await killInsideLock(true);
      const corrupted = !targetAtHead();
      const r =
        next === "driver"
          ? await finish(driver(["perturb-noop"]), 60_000)
          : await finish(
              spawn(
                resolve(ROOT, "node_modules", ".bin", "vitest"),
                [
                  "run",
                  "--dir",
                  "scripts/__tests__",
                  "--testTimeout=30000",
                  "--hookTimeout=30000",
                  "scripts/__tests__/check-spec-routes.test.ts",
                ],
                { cwd: ROOT, env: { ...process.env, CI: "1" } },
              ),
              120_000,
            );
      const atHead = targetAtHead();
      record(
        name,
        corrupted && atHead && r.code === 0,
        `killed client left the file ${corrupted ? "corrupted" : "INTACT (probe did not bite)"}; ` +
          `next run exit ${r.code}; file ${atHead ? "byte-identical to HEAD" : "STILL CORRUPTED"}`,
      );
    } finally {
      if (restoreTarget()) console.log(`  (harness restored ${REL} from HEAD)`);
    }
  }
  const name = "H2 corrupted file with no lock state, next run refuses";
  try {
    resetLock();
    writeFileSync(TARGET, HEAD_BYTES.toString("utf8").split("\n").slice(0, 40).join("\n"));
    const r = await finish(driver(["perturb-noop"]), 60_000);
    const named = r.out.includes(`git checkout HEAD -- ${REL}`);
    record(
      name,
      r.code !== 0 && named,
      r.code === 0
        ? "next run exit 0 — it backed up the corrupted file as the original and blessed it"
        : `next run exit ${r.code}${named ? ", names the restore command" : ", NO restore command"}`,
    );
  } finally {
    if (restoreTarget()) console.log(`  (harness restored ${REL} from HEAD)`);
  }
}

// ── H4 ─────────────────────────────────────────────────────────────────────

async function h4(): Promise<void> {
  await killInsideLock();
  const n = fakePidReuse(process.pid);
  const r = await finish(driver(["acquire"]), 20_000);
  if (r.timedOut || r.code !== 0) resetLock();
  record(
    "H4 live pid with a foreign start time is stale",
    n > 0 && r.code === 0 && r.ms < 5_000,
    r.timedOut ? "acquire still waiting after 20 s" : `acquired in ${r.ms} ms (exit ${r.code})`,
  );
}

async function main(): Promise<void> {
  try {
    if (which === "h1" || which === "all") await h1();
    if (which === "h2" || which === "all") await h2();
    if (which === "h4" || which === "all") await h4();
  } finally {
    if (restoreTarget()) console.log(`(harness restored ${REL} from HEAD)`);
  }
  const red = results.filter((r) => !r.green);
  console.log(`repo-lock harness: ${results.length - red.length}/${results.length} green`);
  process.exit(red.length === 0 ? 0 : 1);
}

void main();
