/**
 * probe-turbo-remote-cache-signing — does turbo, configured the way THIS
 * repo's turbo.json configures it, refuse a remote-cache artifact it did not
 * sign? (#997)
 *
 * The defect: turbo.json had no `remoteCache.signature`, so turbo ignored
 * `TURBO_REMOTE_CACHE_SIGNATURE_KEY` — every remote PUT went up unsigned and
 * every GET accepted whatever the cache served. Anyone holding `TURBO_TOKEN`
 * could plant a `dist/` under a real task hash, and a later CI, publish or
 * release run would replay it instead of building. The docs said the cache was
 * HMAC-signed; nothing had ever checked.
 *
 * This probe checks, end to end, against a LOCAL fake Vercel remote cache
 * (`PUT/GET/HEAD /v8/artifacts/:hash`, `POST /v8/artifacts/events`) that
 * records every request's headers. No real token, no real key, no network.
 *
 * The fixture is a one-package workspace whose build copies `payload.txt` from
 * the workspace root (outside the package, so NOT in the task hash) into
 * `dist/out.txt`. That makes a poisoned artifact observable: an attacker run
 * with `payload = POISON` and a victim run with `payload = clean` compute the
 * SAME task hash, so if the victim replays the attacker's entry its
 * `dist/out.txt` says POISON. The fixture's `remoteCache` block is copied from
 * the repo's own turbo.json — the probe tests the repo's configuration, not a
 * configuration of its own.
 *
 * Scenarios (each run starts from an empty LOCAL cache and no `dist/`):
 *
 *   attacker-signed-put   key A, remote:rw, POISON — every PUT carries
 *                         `x-artifact-tag`
 *   wrong-key-miss        key V, remote:r, clean — the key-A entry is a MISS,
 *                         the task executes, `dist` is clean, no PUT
 *   unsigned-miss         the entry re-planted with its tag stripped — MISS
 *   right-key-hit         key A, remote:r — a HIT that restores POISON. The
 *                         non-vacuity control: proves the probe can see a hit
 *   no-key-write          NO key, remote:rw — the run must succeed and must
 *                         not leave an unsigned entry in the cache
 *   no-key-read           NO key, remote:r, unsigned entry planted — MISS
 *   env-read-only         TURBO_CACHE=local:rw,remote:r in the ENV (the
 *                         workflows' mechanism, a PR job's value) — no PUT
 *   env-main-write        TURBO_CACHE=local:rw,remote:rw in the env (a push to
 *                         main) — a signed PUT
 *   empty-key-write       key SET and EMPTY (an unset secret evaluates to ""),
 *                         remote:rw — must FAIL with no artifact request
 *                         (needs `futureFlags.longerSignatureKey`; without
 *                         it turbo signs with a zero-length key and uploads)
 *   short-key-write       a 31-byte key — same
 *   pr-no-credentials     no token, no key, TURBO_CACHE=local:rw (a
 *                         pull_request / fork / non-main job) — passes,
 *                         zero requests to the remote
 *   writer-before-environment  token AND key set-but-empty, remote:rw (the
 *                         writer job on main before the `turbo-cache-writer`
 *                         environment or its secrets exist) — passes, zero
 *                         requests, nothing stored
 *   committed-turbo-config  key V, remote:rw, with `.turbo/config.json` =
 *                         `{"signature":false}` in the workspace (what a
 *                         `git add -f .turbo/config.json` commits). This one
 *                         proves a HAZARD, not a defence: the file overrides
 *                         turbo.json and the PUT goes up UNSIGNED — which is
 *                         why check-turbo-remote-cache refuses any tracked
 *                         file under `.turbo/`. If a turbo upgrade stops
 *                         honouring the file, this expectation goes red:
 *                         re-evaluate the rule then, do not delete it.
 *
 * Usage:  pnpm probe-turbo-remote-cache-signing [--json]
 * Exit 0 iff every expectation holds; the per-scenario record is printed
 * either way, so a reviewer sees exactly what turbo did.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── The fake Vercel remote cache ────────────────────────────────────────────

export interface CacheRequest {
  method: string;
  path: string;
  hash: string | null;
  /** `x-artifact-tag` as sent (PUT) — `null` when absent. */
  tag: string | null;
  status: number;
}

export interface StoredArtifact {
  body: Buffer;
  tag: string | null;
}

export interface FakeCache {
  url: string;
  requests: CacheRequest[];
  store: Map<string, StoredArtifact>;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

export async function startFakeCache(): Promise<FakeCache> {
  const requests: CacheRequest[] = [];
  const store = new Map<string, StoredArtifact>();
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0]!;
    const method = req.method ?? "GET";
    const tagHeader = req.headers["x-artifact-tag"];
    const tag = typeof tagHeader === "string" ? tagHeader : null;
    const m = /^\/v8\/artifacts\/([^/]+)$/.exec(path);
    const hash = m && m[1] !== "events" && m[1] !== "status" ? m[1]! : null;
    const body = await readBody(req);
    let status = 404;
    const headers: Record<string, string> = {};
    let out: Buffer | string = "";
    if (path === "/v8/artifacts/status") {
      status = 200;
      headers["content-type"] = "application/json";
      out = JSON.stringify({ status: "enabled" });
    } else if (path === "/v8/artifacts/events" && method === "POST") {
      status = 200;
      headers["content-type"] = "application/json";
      out = "{}";
    } else if (hash && method === "PUT") {
      store.set(hash, { body, tag });
      status = 202;
      headers["content-type"] = "application/json";
      out = JSON.stringify({ urls: [`${hash}`] });
    } else if (hash && (method === "GET" || method === "HEAD")) {
      const hit = store.get(hash);
      if (hit) {
        status = 200;
        headers["content-type"] = "application/octet-stream";
        headers["content-length"] = String(hit.body.length);
        if (hit.tag != null) headers["x-artifact-tag"] = hit.tag;
        if (method === "GET") out = hit.body;
      }
    }
    requests.push({ method, path, hash, tag, status });
    res.writeHead(status, headers);
    res.end(out);
  };
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    store,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

// ── The fixture workspace ────────────────────────────────────────────────────

/** The `remoteCache` block of a turbo.json, or `undefined` when it has none. */
export function readRemoteCacheBlock(turboJsonPath: string): unknown {
  const parsed = JSON.parse(readFileSync(turboJsonPath, "utf8")) as { remoteCache?: unknown };
  return parsed.remoteCache;
}

/**
 * The `futureFlags` block of a turbo.json (`longerSignatureKey` makes a
 * short or EMPTY signing key fatal instead of a warning), or `undefined`.
 */
export function readFutureFlags(turboJsonPath: string): unknown {
  const parsed = JSON.parse(readFileSync(turboJsonPath, "utf8")) as { futureFlags?: unknown };
  return parsed.futureFlags;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/**
 * The repo's own `packageManager` — the pnpm already running this repo. A
 * fixture pinning a DIFFERENT pnpm makes pnpm fetch that version before
 * running the build script (and, without a usable HOME, retry forever).
 */
function rootPackageManager(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  return pkg.packageManager ?? "pnpm@9.15.0";
}

export function makeFixture(remoteCache: unknown, futureFlags?: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "turbo-sign-probe-")));
  mkdirSync(join(dir, "packages", "a"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "turbo-sign-probe",
      private: true,
      packageManager: rootPackageManager(),
    }),
  );
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(
    join(dir, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/a: {}\n",
  );
  writeFileSync(
    join(dir, "packages", "a", "package.json"),
    JSON.stringify({ name: "a", version: "0.0.0", scripts: { build: "node build.js" } }),
  );
  writeFileSync(
    join(dir, "packages", "a", "build.js"),
    'const fs = require("fs");\nfs.mkdirSync("dist", { recursive: true });\nfs.writeFileSync("dist/out.txt", fs.readFileSync("../../payload.txt", "utf8"));\n',
  );
  const turbo: Record<string, unknown> = { tasks: { build: { outputs: ["dist/**"] } } };
  if (remoteCache !== undefined) turbo.remoteCache = remoteCache;
  if (futureFlags !== undefined) turbo.futureFlags = futureFlags;
  writeFileSync(join(dir, "turbo.json"), JSON.stringify(turbo, null, 2));
  writeFileSync(join(dir, ".gitignore"), "payload.txt\ndist\n.turbo\n");
  writeFileSync(join(dir, "payload.txt"), "clean\n");
  git(dir, "init", "-q", ".");
  git(dir, "add", "-A");
  git(
    dir,
    "-c",
    "user.email=probe@motebit.invalid",
    "-c",
    "user.name=probe",
    "commit",
    "-qm",
    "fixture",
  );
  return dir;
}

// ── One turbo run ────────────────────────────────────────────────────────────

export interface RunRecord {
  scenario: string;
  exitCode: number | null;
  /** `hit` when turbo replayed an artifact, `executed` when the build ran. */
  outcome: "hit" | "executed" | "unknown";
  /** What the build left in `packages/a/dist/out.txt` (null: nothing). */
  dist: string | null;
  puts: number;
  unsignedPuts: number;
  gets: number;
  /** Every request this run sent to the fake cache (artifacts, status, events). */
  requests: number;
  /** Requests naming an artifact hash (PUT/GET/HEAD /v8/artifacts/:hash). */
  artifactRequests: number;
  /** Turbo's warning lines about the cache or the signature, verbatim. */
  warnings: string[];
  durationMs: number;
}

function turboBin(): string {
  return join(ROOT, "node_modules", ".bin", "turbo");
}

function spawnAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // Async, never spawnSync: the fake cache lives in THIS process, and a
  // blocked event loop cannot answer turbo's requests.
  return new Promise((ok) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      ok({ status, stdout, stderr });
    });
  });
}

export async function runTurbo(opts: {
  scenario: string;
  fixture: string;
  cache: FakeCache;
  key: string | null;
  /**
   * TURBO_TOKEN: `undefined` = a token (the default), `null` = unset (a fork
   * or a job that is not given the secret), `""` = set but EMPTY (what
   * `${{ secrets.X }}` evaluates to when the secret does not exist).
   */
  token?: string | null;
  /** Passed as `--cache=…`, or with `via: "env"` as TURBO_CACHE (the mechanism the workflows use). */
  cacheFlag: string;
  via?: "flag" | "env";
  payload: string;
  /** Written to `<fixture>/.turbo/config.json` for this run (a committed repo-local turbo config). */
  turboConfig?: Record<string, unknown>;
}): Promise<RunRecord> {
  const { fixture, cache } = opts;
  writeFileSync(join(fixture, "payload.txt"), `${opts.payload}\n`);
  rmSync(join(fixture, "packages", "a", "dist"), { recursive: true, force: true });
  const localCache = join(fixture, ".turbo", "probe-cache");
  rmSync(join(fixture, ".turbo"), { recursive: true, force: true });
  if (opts.turboConfig !== undefined) {
    mkdirSync(join(fixture, ".turbo"), { recursive: true });
    writeFileSync(join(fixture, ".turbo", "config.json"), JSON.stringify(opts.turboConfig));
  }
  const before = cache.requests.length;

  // The caller's environment minus every TURBO_* variable (a developer's own
  // token, key or cache mode must not leak into a scenario), then exactly the
  // variables the scenario names. HOME stays real: the fixture's `pnpm run`
  // resolves through corepack, which needs it.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("TURBO_")),
  );
  Object.assign(env, {
    TURBO_API: cache.url,
    TURBO_TEAM: "probe-team",
    TURBO_TELEMETRY_DISABLED: "1",
    TURBO_NO_UPDATE_NOTIFIER: "1",
    TURBO_PRINT_VERSION_DISABLED: "1",
    DO_NOT_TRACK: "1",
    // Never let pnpm try to install a pnpm for the fixture (see rootPackageManager).
    npm_config_manage_package_manager_versions: "false",
  });
  const token = opts.token === undefined ? "probe-token" : opts.token;
  if (token != null) env.TURBO_TOKEN = token;
  if (opts.key != null) env.TURBO_REMOTE_CACHE_SIGNATURE_KEY = opts.key;
  if (opts.via === "env") env.TURBO_CACHE = opts.cacheFlag;

  const t0 = Date.now();
  const r = await spawnAsync(
    turboBin(),
    [
      "run",
      "build",
      "--skip-infer",
      ...(opts.via === "env" ? [] : [`--cache=${opts.cacheFlag}`]),
      `--cache-dir=${localCache}`,
      "--output-logs=full",
      "--log-order=stream",
      "--ui=stream",
    ],
    { cwd: fixture, env, timeoutMs: 120_000 },
  );
  const out = `${r.stdout}\n${r.stderr}`;
  const mine = cache.requests.slice(before);
  const puts = mine.filter((q) => q.method === "PUT" && q.hash != null);
  const distFile = join(fixture, "packages", "a", "dist", "out.txt");
  const outcome = /cache hit/i.test(out)
    ? "hit"
    : /cache (miss|bypass), executing/i.test(out)
      ? "executed"
      : "unknown";
  return {
    scenario: opts.scenario,
    exitCode: r.status,
    outcome,
    dist: existsSync(distFile) ? readFileSync(distFile, "utf8").trim() : null,
    puts: puts.length,
    unsignedPuts: puts.filter((q) => q.tag == null || q.tag === "").length,
    gets: mine.filter((q) => q.method === "GET" && q.hash != null).length,
    requests: mine.length,
    artifactRequests: mine.filter((q) => q.hash != null).length,
    durationMs: Date.now() - t0,
    warnings: out
      .split("\n")
      .map((l) => l.trim())
      // eslint-disable-next-line no-control-regex
      .map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""))
      .filter((l) => /warn|signature|artifact|remote cach|failed/i.test(l))
      .filter((l) => !/Remote caching enabled/i.test(l)),
  };
}

// ── The probe ────────────────────────────────────────────────────────────────

export interface Expectation {
  scenario: string;
  claim: string;
  ok: boolean;
}

export interface ProbeResult {
  remoteCache: unknown;
  futureFlags: unknown;
  runs: RunRecord[];
  expectations: Expectation[];
  ok: boolean;
}

const KEY_ATTACKER = "a".repeat(64);
const KEY_VICTIM = "v".repeat(64);

export async function runSigningProbe(
  turboJsonPath = join(ROOT, "turbo.json"),
): Promise<ProbeResult> {
  const remoteCache = readRemoteCacheBlock(turboJsonPath);
  const futureFlags = readFutureFlags(turboJsonPath);
  const fixture = makeFixture(remoteCache, futureFlags);
  const cache = await startFakeCache();
  const runs: RunRecord[] = [];
  const expectations: Expectation[] = [];
  const expect = (scenario: string, claim: string, ok: boolean): void => {
    expectations.push({ scenario, claim, ok });
  };
  const RW = "local:rw,remote:rw";
  const R = "local:rw,remote:r";
  try {
    // 1. The attacker (or any token holder) writes a POISON artifact.
    const a = await runTurbo({
      scenario: "attacker-signed-put",
      fixture,
      cache,
      key: KEY_ATTACKER,
      cacheFlag: RW,
      payload: "POISON",
    });
    runs.push(a);
    expect(a.scenario, "the run succeeds", a.exitCode === 0);
    expect(a.scenario, "at least one artifact PUT reached the remote", a.puts >= 1);
    expect(a.scenario, "every PUT carries x-artifact-tag", a.puts >= 1 && a.unsignedPuts === 0);
    const planted = new Map([...cache.store].map(([h, v]) => [h, { ...v }]));

    // 2. A victim with a DIFFERENT key must not replay it.
    const b = await runTurbo({
      scenario: "wrong-key-miss",
      fixture,
      cache,
      key: KEY_VICTIM,
      cacheFlag: R,
      payload: "clean",
    });
    runs.push(b);
    expect(b.scenario, "the run succeeds", b.exitCode === 0);
    expect(
      b.scenario,
      "the entry signed with another key is NOT a hit (the task executes)",
      b.outcome === "executed",
    );
    expect(
      b.scenario,
      "dist holds the victim's own build, not the planted artifact",
      b.dist === "clean",
    );
    expect(b.scenario, "remote:r writes nothing", b.puts === 0);

    // 3. The same entry, tag stripped: an UNSIGNED plant.
    cache.store.clear();
    for (const [h, v] of planted) cache.store.set(h, { body: v.body, tag: null });
    const c = await runTurbo({
      scenario: "unsigned-miss",
      fixture,
      cache,
      key: KEY_VICTIM,
      cacheFlag: R,
      payload: "clean",
    });
    runs.push(c);
    expect(c.scenario, "the run succeeds", c.exitCode === 0);
    expect(
      c.scenario,
      "an unsigned entry is NOT a hit (the task executes)",
      c.outcome === "executed",
    );
    expect(c.scenario, "dist holds the victim's own build", c.dist === "clean");

    // 4. Control: the key that signed it DOES hit — the probe can see a hit.
    cache.store.clear();
    for (const [h, v] of planted) cache.store.set(h, v);
    const d = await runTurbo({
      scenario: "right-key-hit",
      fixture,
      cache,
      key: KEY_ATTACKER,
      cacheFlag: R,
      payload: "clean",
    });
    runs.push(d);
    expect(
      d.scenario,
      "the correctly signed entry IS a hit (non-vacuity control)",
      d.outcome === "hit",
    );
    expect(d.scenario, "the hit restores the signed artifact", d.dist === "POISON");

    // 5. Signature on, NO key, remote write allowed (a developer who ran
    //    `turbo login` but holds no key): must not error, must not write
    //    an unsigned entry.
    cache.store.clear();
    const e = await runTurbo({
      scenario: "no-key-write",
      fixture,
      cache,
      key: null,
      cacheFlag: RW,
      payload: "clean",
    });
    runs.push(e);
    const unsignedStored = [...cache.store.values()].filter(
      (v) => v.tag == null || v.tag === "",
    ).length;
    expect(
      e.scenario,
      "the run succeeds (a missing key never breaks a local build)",
      e.exitCode === 0,
    );
    expect(e.scenario, "the task executes", e.outcome === "executed" && e.dist === "clean");
    expect(
      e.scenario,
      "no unsigned entry is written",
      e.unsignedPuts === 0 && unsignedStored === 0,
    );

    // 6. Signature on, NO key, an unsigned entry planted: must not replay it.
    cache.store.clear();
    for (const [h, v] of planted) cache.store.set(h, { body: v.body, tag: null });
    const f = await runTurbo({
      scenario: "no-key-read",
      fixture,
      cache,
      key: null,
      cacheFlag: R,
      payload: "clean",
    });
    runs.push(f);
    expect(f.scenario, "the run succeeds", f.exitCode === 0);
    expect(
      f.scenario,
      "the unsigned entry is NOT a hit",
      f.outcome === "executed" && f.dist === "clean",
    );

    // 7. The workflows' mechanism: TURBO_CACHE in the ENVIRONMENT, no flag,
    //    with a valid key — the value a pull_request job gets. No write.
    cache.store.clear();
    const g = await runTurbo({
      scenario: "env-read-only",
      fixture,
      cache,
      key: KEY_VICTIM,
      cacheFlag: R,
      via: "env",
      payload: "clean",
    });
    runs.push(g);
    expect(g.scenario, "the run succeeds", g.exitCode === 0);
    expect(g.scenario, "TURBO_CACHE=local:rw,remote:r in the env writes nothing", g.puts === 0);

    // 8. …and the value a push to main gets: a signed write.
    const h = await runTurbo({
      scenario: "env-main-write",
      fixture,
      cache,
      key: KEY_VICTIM,
      cacheFlag: RW,
      via: "env",
      payload: "clean",
    });
    runs.push(h);
    expect(
      h.scenario,
      "TURBO_CACHE=local:rw,remote:rw in the env writes, signed",
      h.puts >= 1 && h.unsignedPuts === 0,
    );

    // 9. C1: an EMPTY key. `${{ secrets.KEY }}` evaluates to "" when the secret
    //    is unset, so the variable is SET and empty. Without
    //    `futureFlags.longerSignatureKey` turbo signs with a zero-length HMAC
    //    key (reproducible by anyone) and uploads, with a warning only. With
    //    the flag it must refuse: non-zero exit, no artifact request at all.
    cache.store.clear();
    const i = await runTurbo({
      scenario: "empty-key-write",
      fixture,
      cache,
      key: "",
      cacheFlag: RW,
      via: "env",
      payload: "clean",
    });
    runs.push(i);
    expect(i.scenario, "the run fails (an empty key is fatal)", i.exitCode !== 0);
    expect(i.scenario, "no artifact request reaches the cache", i.artifactRequests === 0);
    expect(i.scenario, "nothing is stored", cache.store.size === 0);

    // 10. A SHORT key (31 bytes, one under turbo's 32-byte minimum): same.
    const j = await runTurbo({
      scenario: "short-key-write",
      fixture,
      cache,
      key: "k".repeat(31),
      cacheFlag: RW,
      via: "env",
      payload: "clean",
    });
    runs.push(j);
    expect(j.scenario, "the run fails (a short key is fatal)", j.exitCode !== 0);
    expect(j.scenario, "no artifact request reaches the cache", j.artifactRequests === 0);
    expect(j.scenario, "nothing is stored", cache.store.size === 0);

    // 11. A pull_request / fork / non-main job after the "key only on
    //     main" change: no token, no key, local cache only. It must pass
    //     and never touch the remote.
    const k = await runTurbo({
      scenario: "pr-no-credentials",
      fixture,
      cache,
      key: null,
      token: null,
      cacheFlag: "local:rw",
      via: "env",
      payload: "clean",
    });
    runs.push(k);
    expect(k.scenario, "the run succeeds", k.exitCode === 0);
    expect(k.scenario, "the task executes", k.outcome === "executed" && k.dist === "clean");
    expect(k.scenario, "zero requests reach the remote cache", k.requests === 0);

    // 12. The workflow merged BEFORE the `turbo-cache-writer` environment (or
    //     its secrets) exists: on a push to main both secrets evaluate to ""
    //     — token SET-and-empty, key SET-and-empty, remote:rw requested. It
    //     must pass with no remote cache: zero requests, never a write.
    cache.store.clear();
    const l = await runTurbo({
      scenario: "writer-before-environment",
      fixture,
      cache,
      key: "",
      token: "",
      cacheFlag: RW,
      via: "env",
      payload: "clean",
    });
    runs.push(l);
    expect(l.scenario, "the run succeeds", l.exitCode === 0);
    expect(l.scenario, "the task executes", l.outcome === "executed" && l.dist === "clean");
    expect(l.scenario, "zero requests reach the remote cache", l.requests === 0);
    expect(l.scenario, "nothing is stored", cache.store.size === 0);

    // 13. HAZARD (#997 round 2, C4): a repo-local `.turbo/config.json` —
    //     gitignored, but `git add -f` commits it — overrides turbo.json.
    //     `{"signature":false}` with a real key and remote:rw uploads
    //     UNSIGNED. The expectation is that the override IS honoured: that is
    //     the reason check-turbo-remote-cache refuses tracked `.turbo/` files.
    cache.store.clear();
    const m = await runTurbo({
      scenario: "committed-turbo-config",
      fixture,
      cache,
      key: KEY_VICTIM,
      cacheFlag: RW,
      via: "env",
      payload: "clean",
      turboConfig: { signature: false },
    });
    runs.push(m);
    expect(m.scenario, "the run succeeds", m.exitCode === 0);
    expect(
      m.scenario,
      "HAZARD: the repo-local .turbo/config.json overrides turbo.json — the PUT goes up UNSIGNED (so the gate must refuse a tracked .turbo/)",
      m.puts >= 1 && m.unsignedPuts === m.puts,
    );
  } finally {
    await cache.close();
    rmSync(fixture, { recursive: true, force: true });
  }
  return { remoteCache, futureFlags, runs, expectations, ok: expectations.every((x) => x.ok) };
}

function report(result: ProbeResult): string {
  const lines: string[] = [];
  lines.push(`turbo.json remoteCache: ${JSON.stringify(result.remoteCache) ?? "(absent)"}`);
  lines.push(`turbo.json futureFlags: ${JSON.stringify(result.futureFlags) ?? "(absent)"}`);
  for (const r of result.runs) {
    lines.push(
      `\n[${r.scenario}] exit=${r.exitCode} outcome=${r.outcome} dist=${r.dist ?? "(none)"} PUTs=${r.puts} (unsigned ${r.unsignedPuts}) GETs=${r.gets} requests=${r.requests} (artifact ${r.artifactRequests}) (${r.durationMs}ms)`,
    );
    for (const w of r.warnings) lines.push(`    turbo: ${w}`);
    for (const x of result.expectations.filter((e) => e.scenario === r.scenario)) {
      lines.push(`  ${x.ok ? "✓" : "✗"} ${x.claim}`);
    }
  }
  const failed = result.expectations.filter((x) => !x.ok).length;
  lines.push(
    failed === 0
      ? `\n✓ turbo remote-cache signing: ${result.expectations.length} expectation(s) held across ${result.runs.length} turbo run(s) against a local fake cache.`
      : `\n✗ turbo remote-cache signing: ${failed} of ${result.expectations.length} expectation(s) FAILED. Fix: set "remoteCache": { "signature": true } and "futureFlags": { "longerSignatureKey": true } in turbo.json (docs/ops/RUNBOOK.md § Turbo remote cache) and re-run \`pnpm probe-turbo-remote-cache-signing\`.`,
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSigningProbe().then(
    (result) => {
      if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
      else console.log(report(result));
      process.exit(result.ok ? 0 : 1);
    },
    (err: unknown) => {
      console.error(`✗ probe could not run: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
