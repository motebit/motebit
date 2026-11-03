/**
 * `motebit repo-task run` — the agent side of a governed repo change
 * (docs/proposals/governed-repo-change-v1.md § "The chain", steps 4–7).
 *
 * Fixture git repositories in temp directories, ephemeral keys for the
 * principal F and the agent A, a scripted model (never a real one), and
 * HOME redirected to an empty temp home whose `~/.motebit/config.json` is
 * unreadable (mode 000): any read of it would throw. The judge of the output
 * is the verifier itself (`verifyRepoChange`), recomputed here from the
 * repository by real git, independently of the command's own self-check.
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const HOME = vi.hoisted(async () => {
  const nfs = await import("node:fs");
  const nos = await import("node:os");
  const npath = await import("node:path");
  const home = nfs.realpathSync(nfs.mkdtempSync(npath.join(nos.tmpdir(), "repo-task-run-home-")));
  process.env.HOME = home;
  delete process.env.MOTEBIT_CONFIG_DIR;
  delete process.env.MOTEBIT_PASSPHRASE;
  delete process.env.MOTEBIT_AGENT_PASSPHRASE;
  return home;
});

import {
  bytesToHex,
  canonicalJson,
  deriveSovereignMotebitId,
  generateKeypair,
  secureErase,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { StreamingProvider } from "@motebit/ai-core";
import { generate } from "@motebit/identity-file";
import type { RepoTaskPin } from "@motebit/runtime";
import type { AIResponse, ContextPack, ToolCall } from "@motebit/sdk";
import { isFullyVerified } from "@motebit/verifier";
import {
  listTree,
  openIsolatedGit,
  verifyRepoChangeLanded,
  verifyRepoChangePullRequest,
} from "@motebit/verify/git";

import { parseCliArgs } from "../../args.js";
import { encryptPrivateKey, loadActiveSigningKey } from "../../identity.js";
import { handleRepoTaskRun } from "../../subcommands/repo-task.js";
import type { RepoTaskRunCommandDeps } from "../../subcommands/repo-task.js";
import { defaultConfigDirs } from "../agent-identity.js";
import { delegateToDirectory, mintRepoTaskRevocation } from "../delegation.js";
import { readTipState } from "../preflight.js";

const NOW = 1_900_000_000_000;
const HOUR = 3_600_000;
const REPO = "motebit/motebit";
const PASS = "agent passphrase";
const DOC = "notes/guide.md";
const POLICY = JSON.stringify({
  spec: "motebit/repo-path-policy@1.0",
  include: ["notes/*.md"],
  exclude: [".motebit"],
});

class ExitCalled extends Error {}

interface Party {
  keys: KeyPair;
  pin: RepoTaskPin;
}
async function party(): Promise<Party> {
  const keys = await generateKeypair();
  const public_key = bytesToHex(keys.publicKey);
  return { keys, pin: { motebit_id: await deriveSovereignMotebitId(public_key), public_key } };
}
async function identityFile(p: Party): Promise<string> {
  return generate(
    { motebitId: p.pin.motebit_id, ownerId: "owner", publicKeyHex: p.pin.public_key },
    p.keys.privateKey,
  );
}

let home = "";
let f: Party;
let a: Party;
let x: Party;
let agentDir = "";
let agentConfig: Record<string, unknown>;
let tmp = "";

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_AUTHOR_DATE: "@1800000000 +0000",
    GIT_COMMITTER_DATE: "@1800000000 +0000",
  };
}
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
/**
 * A test stand-in for GitHub's commit signer: an ephemeral RSA key, its
 * OpenPGP v4 public key block (the pinned-keys file), and `sign`, which
 * inserts a v4 binary RSA/SHA-256 signature over the commit as its `gpgsig`
 * header (RFC 4880 §5.2.3, §5.2.4, §6). No network, no real GitHub key.
 */
/** CRC-24 (RFC 4880 §6.1), the test signer's own copy: the code under test is never its oracle. */
function crc24(bytes: Uint8Array): number {
  let crc = 0xb704ce;
  for (const b of bytes) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

function testGithubSigner(): {
  armored: string;
  sign: (payload: Buffer, seconds: number) => Buffer;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  // Minimal (RFC 4880 §3.2): a signature from `sign()` is modulus-length and
  // may start with a zero byte, which an exact bit count must not carry.
  const mpi = (value: Buffer): Buffer => {
    let i = 0;
    while (i < value.length - 1 && value[i] === 0) i++;
    const v = value.subarray(i);
    const head = Buffer.alloc(2);
    head.writeUInt16BE((v.length - 1) * 8 + (32 - Math.clz32(v[0]!)));
    return Buffer.concat([head, v]);
  };
  const pkt = (tag: number, body: Buffer): Buffer => {
    const n = body.length - 192;
    const len =
      body.length < 192 ? Buffer.from([body.length]) : Buffer.from([(n >> 8) + 192, n & 0xff]);
    return Buffer.concat([Buffer.from([0xc0 | tag]), len, body]);
  };
  const armor = (label: string, data: Buffer): string => {
    const crc = Buffer.alloc(3);
    crc.writeUIntBE(crc24(data), 0, 3);
    const lines = data.toString("base64").match(/.{1,64}/g)!;
    return [
      `-----BEGIN ${label}-----`,
      "",
      ...lines,
      `=${crc.toString("base64")}`,
      `-----END ${label}-----`,
    ].join("\n");
  };
  const keyBody = Buffer.concat([
    Buffer.from([4, 0x65, 0x53, 0xf1, 0x00, 1]),
    mpi(Buffer.from(jwk.n!, "base64url")),
    mpi(Buffer.from(jwk.e!, "base64url")),
  ]);
  const fingerprint = createHash("sha1")
    .update(Buffer.from([0x99, keyBody.length >> 8, keyBody.length & 0xff]))
    .update(keyBody)
    .digest();
  return {
    armored: `${armor("PGP PUBLIC KEY BLOCK", pkt(6, keyBody))}\n`,
    sign: (payload, seconds) => {
      const time = Buffer.alloc(4);
      time.writeUInt32BE(seconds);
      const hashed = Buffer.concat([
        Buffer.from([5, 2]),
        time,
        Buffer.from([22, 33, 4]),
        fingerprint,
      ]);
      const portion = Buffer.concat([Buffer.from([4, 0x00, 1, 8, 0, hashed.length]), hashed]);
      const trailer = Buffer.from([4, 0xff, 0, 0, 0, portion.length]);
      const signed = Buffer.concat([payload, portion, trailer]);
      const digest = createHash("sha256").update(signed).digest();
      const sig = cryptoSign("sha256", signed, privateKey);
      const body = Buffer.concat([portion, Buffer.from([0, 0]), digest.subarray(0, 2), mpi(sig)]);
      const lines = armor("PGP SIGNATURE", pkt(2, body)).split("\n");
      const header = [`gpgsig ${lines[0]!}`, ...lines.slice(1).map((l) => ` ${l}`)].join("\n");
      const text = payload.toString("latin1");
      const end = text.indexOf("\n\n");
      return Buffer.from(`${text.slice(0, end)}\n${header}${text.slice(end)}`, "latin1");
    },
  };
}

/** The common git directory of `repo` (its own `.git` for an ordinary repository). */
function gitCommonDir(repo: string): string {
  return path.resolve(repo, git(repo, "rev-parse", "--git-common-dir").trim());
}

function writeFile(repo: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
}

/** A config directory holding exactly the given config.json. */
function configDir(name: string, config: Record<string, unknown>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

/** The `~/.motebit` of the redirected home: its stat, never its content. */
function homeState(): string {
  const dir = path.join(home, ".motebit");
  const st = (p: string) => {
    const s = fs.lstatSync(p);
    return `${s.mode}:${s.size}:${s.mtimeMs}`;
  };
  return [st(dir), ...fs.readdirSync(dir).map((n) => `${n}=${st(path.join(dir, n))}`)].join("|");
}

beforeAll(async () => {
  home = await HOME;
  f = await party();
  a = await party();
  x = await party();
  // The principal's own ~/.motebit: present, and unreadable — a read throws.
  fs.mkdirSync(path.join(home, ".motebit"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".motebit", "config.json"), "{}", { mode: 0o000 });
  agentConfig = {
    motebit_id: a.pin.motebit_id,
    device_id: "agent-device",
    device_public_key: a.pin.public_key,
    cli_encrypted_key: await encryptPrivateKey(bytesToHex(a.keys.privateKey), PASS),
    // Fields a run must never read: they would steer the interior.
    personality: { name: "should-not-load" },
    mcp_servers: [{ name: "evil", command: "/bin/false" }],
    governance: { approval_preset: "autonomous" },
    default_provider: "openai",
  };
});
afterAll(() => {
  fs.chmodSync(path.join(home, ".motebit", "config.json"), 0o600);
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-task-run-")));
  agentDir = configDir("agent", agentConfig);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// -- Fixtures --------------------------------------------------------------

interface FixtureOptions {
  /** Default true. */
  principalPin?: boolean;
  /** Default [a]. */
  agentPins?: Party[];
  /** Default POLICY; null = absent. */
  policy?: string | null;
  /** File name → content under .motebit/revocations/. */
  revocations?: (grantId: string) => Promise<Record<string, string>>;
  /** Default [DOC]. */
  paths?: string[];
  /** The bundle path once existed on main's first-parent history. */
  spent?: boolean;
}

interface Fixture {
  root: string;
  repo: string;
  delegation: string;
  grantId: string;
  tip: string;
}

async function fixture(o: FixtureOptions = {}): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(tmp, "fx-"));
  const repo = path.join(root, "repo");
  const delegation = path.join(root, "delegation");
  const grantId = crypto.randomUUID();
  await delegateToDirectory(
    {
      principal: {
        motebitId: f.pin.motebit_id,
        publicKeyHex: f.pin.public_key,
        privateKey: f.keys.privateKey,
      },
      delegate: a.pin,
      repo: REPO,
      baseRef: "main",
      objectFormat: "sha1",
      allowedPaths: o.paths ?? [DOC],
      maxChangedFiles: 1,
      task: "Fix the typo in notes/guide.md.",
      tools: "repo_read_blob,repo_write_path",
      lifetimeMs: HOUR,
      now: NOW - 60_000,
      grantId,
    },
    delegation,
  );
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFile(repo, DOC, "teh typo\n");
  writeFile(repo, "src/code.ts", "export const x = 1;\n");
  if (o.principalPin !== false) {
    writeFile(repo, ".motebit/principals/principal.md", await identityFile(f));
  }
  for (const p of o.agentPins ?? [a]) {
    writeFile(
      repo,
      `.motebit/principals/agents/${p.pin.motebit_id.slice(0, 12)}.md`,
      await identityFile(p),
    );
  }
  const policy = o.policy === undefined ? POLICY : o.policy;
  if (policy !== null) writeFile(repo, ".motebit/repo-path-policy.json", policy);
  for (const [name, content] of Object.entries((await o.revocations?.(grantId)) ?? {})) {
    writeFile(repo, `.motebit/revocations/${name}`, content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (o.spent) {
    writeFile(repo, `.motebit/bundles/${grantId}.json`, "{}");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "landed");
    git(repo, "rm", "-q", `.motebit/bundles/${grantId}.json`);
    git(repo, "commit", "-q", "-m", "deleted");
  }
  return { root, repo, delegation, grantId, tip: git(repo, "rev-parse", "HEAD") };
}

/** A scripted model: each turn's tool calls, then a final answer. Counts its calls. */
function scripted(turns: ToolCall[][], onDone?: () => void): StreamingProvider & { calls: number } {
  let n = 0;
  const respond = (): AIResponse => {
    provider.calls++;
    const calls = turns[n++];
    if (!calls) onDone?.();
    return calls
      ? { text: "", confidence: 1, memory_candidates: [], state_updates: {}, tool_calls: calls }
      : { text: "Fixed.", confidence: 1, memory_candidates: [], state_updates: {} };
  };
  const provider = {
    calls: 0,
    model: "scripted-model",
    setModel: vi.fn(),
    generate: async (_: ContextPack) => respond(),
    estimateConfidence: async () => 1,
    extractMemoryCandidates: async () => [],
    async *generateStream(_: ContextPack) {
      yield { type: "done" as const, response: respond() };
    },
  };
  return provider as unknown as StreamingProvider & { calls: number };
}

const FIX_TURNS: ToolCall[][] = [
  [{ id: "1", name: "repo_read_blob", args: { path: DOC } }],
  [{ id: "2", name: "repo_write_path", args: { path: DOC, content: "the typo\n" } }],
];

interface Harness {
  deps: RepoTaskRunCommandDeps;
  events: string[];
  lines: string[];
  loaded: Uint8Array[];
  erased: Uint8Array[];
  provider: StreamingProvider & { calls: number };
}

function harness(
  o: {
    provider?: StreamingProvider & { calls: number };
    now?: () => number;
  } = {},
): Harness {
  const events: string[] = [];
  const lines: string[] = [];
  const loaded: Uint8Array[] = [];
  const erased: Uint8Array[] = [];
  const provider = o.provider ?? scripted(FIX_TURNS);
  const deps: RepoTaskRunCommandDeps = {
    loadActiveSigningKey: async (c, opts) => {
      events.push("unlock");
      const k = await loadActiveSigningKey(c, opts);
      loaded.push(k.privateKey);
      return k;
    },
    secureErase: (key) => {
      events.push("erase");
      erased.push(key);
      secureErase(key);
    },
    createProvider: () => {
      events.push("provider");
      return provider;
    },
    getPassphrase: async () => PASS,
    defaultConfigDirs: () => defaultConfigDirs(),
    now: o.now ?? (() => NOW),
    runtimeVersion: "motebit test",
    exit: (code) => {
      events.push(`exit ${code}`);
      throw new ExitCalled(String(code));
    },
    log: (line) => lines.push(line),
  };
  return { deps, events, lines, loaded, erased, provider };
}

function args(fx: Fixture, over: { agent?: string; delegation?: string; output?: string } = {}) {
  return parseCliArgs([
    "repo-task",
    "run",
    "--agent",
    over.agent ?? agentDir,
    "--delegation",
    over.delegation ?? fx.delegation,
    "--repo",
    fx.repo,
    ...(over.output !== undefined ? ["--output", over.output] : []),
  ]);
}

/** Every file under `dir` (excluding `.git`) → its bytes, and symlinks → their targets. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (rel === ".git") continue;
      if (e.isSymbolicLink()) out.set(rel, `symlink:${fs.readlinkSync(full)}`);
      else if (e.isDirectory()) walk(full);
      else out.set(rel, fs.readFileSync(full).toString("hex"));
    }
  };
  walk(dir);
  return out;
}

/** HEAD, the index, every ref (loose and packed), the reflogs. */
function refState(repo: string): Map<string, string> {
  const gitDir = path.join(repo, ".git");
  const out = new Map<string, string>();
  for (const name of ["HEAD", "index", "packed-refs", "ORIG_HEAD", "FETCH_HEAD"]) {
    const full = path.join(gitDir, name);
    out.set(name, fs.existsSync(full) ? fs.readFileSync(full).toString("hex") : "absent");
  }
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(gitDir, full), fs.readFileSync(full).toString("hex"));
    }
  };
  walk(path.join(gitDir, "refs"));
  walk(path.join(gitDir, "logs"));
  out.set("for-each-ref", git(repo, "for-each-ref", "--format=%(refname) %(objectname)"));
  return out;
}

async function expectRefusal(h: Harness, run: () => Promise<void>, text: RegExp): Promise<void> {
  await expect(run()).rejects.toBeInstanceOf(ExitCalled);
  const printed = vi
    .mocked(console.error)
    .mock.calls.map((c) => String(c[0]))
    .join("\n");
  expect(printed).toMatch(/Refused before the first model call/);
  expect(printed).toMatch(text);
  // No model call, no provider built, no key unlocked.
  expect(h.provider.calls).toBe(0);
  expect(h.events).toEqual(["exit 1"]);
}

// -- End to end --------------------------------------------------------------

describe("repo-task run: a governed change, end to end", () => {
  it("makes the change commit and the bundle commit, verified, moving no ref", async () => {
    const fx = await fixture();
    const h = harness();
    const worktreeBefore = snapshot(fx.repo);
    const refsBefore = refState(fx.repo);
    const homeBefore = homeState();

    await handleRepoTaskRun(args(fx), h.deps);

    expect(h.provider.calls).toBe(3);
    const field = (name: string): string => {
      const line = h.lines.find((l) => l.trim().startsWith(name));
      expect(line, name).toBeDefined();
      return line!.trim().split(/\s+/)[1]!;
    };
    const parent = field("parent_commit");
    const head = field("head_commit");
    const bundleCommit = field("bundle_commit");
    expect(parent).toBe(fx.tip);
    // Both commits exist, linear on the tip.
    expect(git(fx.repo, "cat-file", "-t", head)).toBe("commit");
    expect(git(fx.repo, "cat-file", "-t", bundleCommit)).toBe("commit");
    expect(git(fx.repo, "rev-parse", `${head}^`)).toBe(fx.tip);
    expect(git(fx.repo, "rev-parse", `${bundleCommit}^`)).toBe(head);
    expect(git(fx.repo, "diff-tree", "-r", "--no-commit-id", "--name-status", fx.tip, head)).toBe(
      `M\t${DOC}`,
    );
    expect(git(fx.repo, "cat-file", "-p", `${head}:${DOC}`)).toBe("the typo");
    // The bundle commit adds exactly one file: the grant's bundle.
    const bundleFile = `.motebit/bundles/${fx.grantId}.json`;
    expect(
      git(fx.repo, "diff-tree", "-r", "--no-commit-id", "--name-status", head, bundleCommit),
    ).toBe(`A\t${bundleFile}`);
    expect(git(fx.repo, "ls-tree", bundleCommit, bundleFile).split(/\s/)[0]).toBe("100644");
    // Its bytes are canonical JSON of exactly the six keys.
    const bytes = execFileSync("git", ["cat-file", "blob", `${bundleCommit}:${bundleFile}`], {
      cwd: fx.repo,
      env: gitEnv(),
    });
    const text = bytes.toString("utf8");
    const bundle = JSON.parse(text) as Record<string, unknown>;
    expect(canonicalJson(bundle)).toBe(text);
    expect(Object.keys(bundle).sort()).toEqual(
      ["grant", "receipt", "scope", "spec", "tick", "tool_receipts"].sort(),
    );
    const receipt = bundle.receipt as Record<string, unknown>;
    expect(receipt.status).toBe("completed");
    expect(receipt.memories_formed).toBe(0);
    expect(receipt.public_key).toBe(a.pin.public_key);
    const record = JSON.parse(receipt.result as string) as Record<string, unknown>;
    expect(canonicalJson(record)).toBe(receipt.result);
    expect(record.parent_commit).toBe(fx.tip);
    expect(record.head_commit).toBe(head);
    expect((bundle.tool_receipts as unknown[]).length).toBe(2);

    // The verifier, recomputed here from the repository: fully verified, completed.
    const { verifyRepoChange } = await import("@motebit/verifier");
    const session = await openIsolatedGit({
      gitEntry: path.join(fx.repo, ".git"),
      objectFormat: "sha1",
    });
    try {
      const tree = await listTree(session, fx.tip);
      const state = await readTipState(session, fx.tip, tree);
      const blob = git(fx.repo, "rev-parse", `${head}:${DOC}`);
      const verdict = await verifyRepoChange({
        bundle: new Uint8Array(bytes),
        entries: [
          {
            kind: "modify",
            path: new TextEncoder().encode(DOC),
            mode: "100644",
            previousMode: "100644",
            blob,
            containsNul: false,
          },
        ],
        trackedPaths: tree.map((e) => e.path),
        pins: { principal: state.principal, agents: state.agents },
        isPathPermitted: state.isPathPermitted,
        revocations: { set: [], failures: [], freshness: { basis: "asserted", asOf: {} } },
        spent: false,
        expectedRepo: REPO,
        mode: { kind: "pull_request", shapeFailures: [], now: NOW },
      });
      expect(verdict.diagnostics.failures).toEqual([]);
      expect(isFullyVerified(verdict.verdict)).toBe(true);
      expect(verdict.outcome).toBe("completed");
    } finally {
      session.close();
    }

    // The command's own self-check said so, and printed the push template.
    expect(h.lines.join("\n")).toMatch(
      /integrity verified, identityBinding pinned, authority valid, revocation fresh; outcome completed/,
    );
    expect(h.lines.join("\n")).toContain(
      `git push <publisher-remote> ${bundleCommit}:refs/heads/repo-task/${fx.grantId}`,
    );
    expect(h.events).not.toContain("exit 1");

    // No ref moved, the worktree is byte-identical, ~/.motebit untouched.
    expect(refState(fx.repo)).toEqual(refsBefore);
    expect(snapshot(fx.repo)).toEqual(worktreeBefore);
    expect(homeState()).toBe(homeBefore);
    // The receipts went outside the repository, beside the delegation.
    const receiptsFiles = fs.readdirSync(fx.delegation).filter((n) => n.startsWith("receipts-"));
    expect(receiptsFiles).toHaveLength(1);
  });

  it("motebit-verify repo-change agrees: fully verified; one byte of the bundle changed fails", async () => {
    const fx = await fixture();
    const h = harness();
    await handleRepoTaskRun(args(fx), h.deps);
    const bundleCommit = h.lines
      .find((l) => l.trim().startsWith("bundle_commit"))!
      .trim()
      .split(/\s+/)[1]!;
    const check = (head: string) =>
      verifyRepoChangePullRequest({
        repo: fx.repo,
        base: fx.tip,
        head,
        repository: REPO,
        baseRef: "main",
        prAuthor: "motebit-agent",
        now: NOW,
      });
    // The CI verifier, from the repository alone: the producer's output passes.
    const ok = await check(bundleCommit);
    expect(ok.verification.diagnostics.failures).toEqual([]);
    expect(ok.computed.shapeFailures).toEqual([]);
    expect(ok.accepted).toBe(true);

    // The same pull request with one byte of the bundle changed: a sibling
    // bundle commit on the same change commit, built with plumbing on a
    // private index.
    const changeCommit = git(fx.repo, "rev-parse", `${bundleCommit}^`);
    const bundleFile = `.motebit/bundles/${fx.grantId}.json`;
    const bytes = execFileSync("git", ["cat-file", "blob", `${bundleCommit}:${bundleFile}`], {
      cwd: fx.repo,
      env: gitEnv(),
    });
    const i = bytes.indexOf(Buffer.from('"status":"completed"'));
    expect(i).toBeGreaterThan(0);
    const tampered = Buffer.from(bytes);
    tampered[i + 10] = "C".charCodeAt(0); // "completed" → "Completed"
    const env = { ...gitEnv(), GIT_INDEX_FILE: path.join(tmp, "tamper-index") };
    const run = (argv: string[], input?: Buffer) =>
      execFileSync("git", argv, { cwd: fx.repo, env, input, encoding: "utf8" }).trim();
    const blob = run(["hash-object", "-w", "--stdin"], tampered);
    run(["read-tree", changeCommit]);
    run(["update-index", "--add", "--cacheinfo", `100644,${blob},${bundleFile}`]);
    const tree = run(["write-tree"]);
    const forged = run(["commit-tree", tree, "-p", changeCommit, "-m", "bundle"]);
    const bad = await check(forged);
    expect(bad.accepted).toBe(false);
    expect(isFullyVerified(bad.verification.verdict)).toBe(false);
  });

  it("motebit-verify repo-change --landed agrees: the run's output, squash-landed and signed, verifies offline", async () => {
    const fx = await fixture();
    const h = harness();
    await handleRepoTaskRun(args(fx), h.deps);
    const bundleCommit = h.lines
      .find((l) => l.trim().startsWith("bundle_commit"))!
      .trim()
      .split(/\s+/)[1]!;
    // The merge queue's squash: the pull request head's tree on the tip,
    // committed and signed by (a test stand-in for) GitHub.
    const signer = testGithubSigner();
    const seconds = Math.floor(NOW / 1000);
    const payload = Buffer.from(
      [
        `tree ${git(fx.repo, "rev-parse", `${bundleCommit}^{tree}`)}`,
        `parent ${fx.tip}`,
        `author motebit-agent <agent@example.com> ${seconds} +0000`,
        `committer GitHub <noreply@github.com> ${seconds} +0000`,
        "",
        "Fix the typo (#1)\n",
      ].join("\n"),
    );
    const squash = execFileSync(
      "git",
      ["hash-object", "-w", "-t", "commit", "--literally", "--stdin"],
      { cwd: fx.repo, env: gitEnv(), input: signer.sign(payload, seconds), encoding: "utf8" },
    ).trim();
    git(fx.repo, "update-ref", "refs/heads/main", squash);
    const landed = (keys: string) =>
      verifyRepoChangeLanded({
        repo: fx.repo,
        landed: squash,
        trustedTip: squash,
        repository: REPO,
        signingKeys: keys,
      });
    const ok = await landed(signer.armored);
    expect(ok.verification.diagnostics.failures).toEqual([]);
    expect(ok.computed.shapeFailures).toEqual([]);
    expect(ok.computed.time.landedAt).toBe(seconds * 1000);
    expect(ok.verification.verdict.temporalBasis).toBe("operator_recorded");
    expect(ok.accepted).toBe(true);
    // Under another pinned key, the landing time is not accepted.
    const other = await landed(testGithubSigner().armored);
    expect(other.verification.verdict.authority).toBe("unknown");
    expect(other.accepted).toBe(false);
  });

  it("a self-check that does not fully verify exits non-zero, publishing nothing", async () => {
    const fx = await fixture();
    let clock = NOW;
    // The tick expires between the run and the self-check.
    const h = harness({
      provider: scripted(FIX_TURNS, () => {
        clock = NOW + 2 * HOUR;
      }),
      now: () => clock,
    });
    const refsBefore = refState(fx.repo);
    await expect(handleRepoTaskRun(args(fx), h.deps)).rejects.toBeInstanceOf(ExitCalled);
    expect(h.events.at(-1)).toBe("exit 1");
    expect(h.lines.join("\n")).toMatch(/authority expired/);
    const printed = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(printed).toMatch(/unreachable objects/);
    expect(h.lines.join("\n")).not.toMatch(/git push/);
    expect(refState(fx.repo)).toEqual(refsBefore);
  });

  it("a run that changes nothing is failed, and exits non-zero", async () => {
    const fx = await fixture();
    const h = harness({ provider: scripted([]) });
    await expect(handleRepoTaskRun(args(fx), h.deps)).rejects.toBeInstanceOf(ExitCalled);
    expect(h.lines[0]).toMatch(/: failed \(model_done\)/);
    expect(h.lines.join("\n")).toMatch(/outcome failed/);
  });
});

// -- Refusals before the first model call -------------------------------------

describe("repo-task run: every preflight rule refuses before the first model call", () => {
  it("an expired tick", async () => {
    const fx = await fixture();
    const h = harness({ now: () => NOW + 2 * HOUR });
    await expectRefusal(h, () => handleRepoTaskRun(args(fx), h.deps), /tick_expired/);
  });

  it("a revoked grant", async () => {
    const fx = await fixture({
      revocations: async (grantId) => {
        const rev = await mintRepoTaskRevocation({
          target: {
            grant_id: grantId,
            delegator_id: f.pin.motebit_id,
            delegator_public_key: f.pin.public_key,
          },
          principal: {
            motebitId: f.pin.motebit_id,
            publicKeyHex: f.pin.public_key,
            privateKey: f.keys.privateKey,
          },
          now: NOW - 1000,
        });
        return { [`${grantId}.json`]: canonicalJson(rev) };
      },
    });
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx), h.deps),
      /revocation\.repo_change\.revoked/,
    );
  });

  it("a malformed revocation file (its name is not its grant_id)", async () => {
    const other = crypto.randomUUID();
    const fx = await fixture({
      revocations: async () => {
        const rev = await mintRepoTaskRevocation({
          target: {
            grant_id: other,
            delegator_id: f.pin.motebit_id,
            delegator_public_key: f.pin.public_key,
          },
          principal: {
            motebitId: f.pin.motebit_id,
            publicKeyHex: f.pin.public_key,
            privateKey: f.keys.privateKey,
          },
          now: NOW - 1000,
        });
        return { [`${crypto.randomUUID()}.json`]: canonicalJson(rev) };
      },
    });
    const h = harness();
    await expectRefusal(h, () => handleRepoTaskRun(args(fx), h.deps), /set_malformed/);
  });

  it("an unparsable revocation file", async () => {
    const fx = await fixture({ revocations: async () => ({ "junk.json": "{not json" }) });
    const h = harness();
    await expectRefusal(h, () => handleRepoTaskRun(args(fx), h.deps), /set_malformed/);
  });

  it("a missing principal pin", async () => {
    const fx = await fixture({ principalPin: false });
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx), h.deps),
      /no principal pin at the tip/,
    );
  });

  it("a missing path policy", async () => {
    const fx = await fixture({ policy: null });
    const h = harness();
    await expectRefusal(h, () => handleRepoTaskRun(args(fx), h.deps), /no path policy at the tip/);
  });

  it("an invalid path policy", async () => {
    const fx = await fixture({
      policy: '{"spec":"motebit/repo-path-policy@1.0","include":["notes/*.md"]}',
    });
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx), h.deps),
      /repo-path-policy\.json does not parse/,
    );
  });

  it("A is not an agent pin at the tip", async () => {
    const fx = await fixture({ agentPins: [x] });
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx), h.deps),
      /--agent is not an agent pin at the tip/,
    );
  });

  it("A is the principal", async () => {
    const fx = await fixture({ agentPins: [a, f] });
    const h = harness();
    const asF = configDir("as-f", {
      ...agentConfig,
      motebit_id: f.pin.motebit_id,
      device_public_key: f.pin.public_key,
    });
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { agent: asF }), h.deps),
      /--agent is the principal/,
    );
  });

  it("a scope path that fails the policy", async () => {
    const fx = await fixture({ paths: ["src/code.ts"] });
    const h = harness();
    await expectRefusal(h, () => handleRepoTaskRun(args(fx), h.deps), /scope_path_not_permitted/);
  });

  it("a dirty worktree: a modified tracked file", async () => {
    const fx = await fixture();
    fs.writeFileSync(path.join(fx.repo, "src/code.ts"), "export const x = 2;\n");
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx), h.deps),
      /"src\/code\.ts": content differs from the tip/,
    );
  });

  it("a dirty worktree: a type change", async () => {
    const fx = await fixture();
    fs.rmSync(path.join(fx.repo, "src/code.ts"));
    fs.symlinkSync("../notes/guide.md", path.join(fx.repo, "src/code.ts"));
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx), h.deps),
      /"src\/code\.ts": not a regular file in the worktree/,
    );
  });

  it("a dirty worktree: a mode change", async () => {
    const fx = await fixture();
    fs.chmodSync(path.join(fx.repo, "src/code.ts"), 0o755);
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx), h.deps),
      /"src\/code\.ts": mode differs/,
    );
  });

  it("the tip is not on base_ref", async () => {
    const fx = await fixture();
    git(fx.repo, "checkout", "-q", "-b", "feature");
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx), h.deps),
      /HEAD is on "refs\/heads\/feature"/,
    );
  });

  it("a detached HEAD", async () => {
    const fx = await fixture();
    git(fx.repo, "checkout", "-q", "--detach");
    const h = harness();
    await expectRefusal(h, () => handleRepoTaskRun(args(fx), h.deps), /HEAD is detached/);
  });

  it("a grant already spent on the tip's first-parent history", async () => {
    const fx = await fixture({ spent: true });
    const h = harness();
    await expectRefusal(h, () => handleRepoTaskRun(args(fx), h.deps), /grant_spent/);
  });

  it("a non-canonical agent key", async () => {
    const fx = await fixture();
    const upper = configDir("upper", {
      ...agentConfig,
      device_public_key: a.pin.public_key.toUpperCase(),
    });
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { agent: upper }), h.deps),
      /not in its one spelling/,
    );
  });

  it("a tick signature re-spelled in non-canonical base64url", async () => {
    const fx = await fixture();
    const tickFile = path.join(fx.delegation, "tick.json");
    const tick = JSON.parse(fs.readFileSync(tickFile, "utf8")) as { signature: string };
    // The last character of an unpadded 64-byte base64url carries 2 unused
    // bits: setting one re-spells the same signature non-canonically.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(tick.signature.at(-1)!);
    tick.signature = tick.signature.slice(0, -1) + alphabet[last | 1];
    fs.chmodSync(tickFile, 0o600);
    fs.writeFileSync(tickFile, JSON.stringify(tick));
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx), h.deps),
      /tick\.signature is not canonical base64url/,
    );
  });

  it("--agent pointing at the default config directory", async () => {
    const fx = await fixture();
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { agent: path.join(home, ".motebit") }), h.deps),
      /default motebit config directory/,
    );
  });

  it("an output directory inside the repository", async () => {
    const fx = await fixture();
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { output: path.join(fx.repo, "out") }), h.deps),
      /inside the repository/,
    );
    expect(fs.existsSync(path.join(fx.repo, "out"))).toBe(false);
  });

  // Path identity is the filesystem's, never the spelling's. A case alias
  // exists only on a case-insensitive filesystem (APFS by default); a hard
  // link exists everywhere.
  const caseInsensitive = (dir: string): boolean =>
    fs.existsSync(dir.replace(/[a-z](?=[^/]*$)/, (c) => c.toUpperCase()));

  it("--agent naming the default config directory by a case alias", async (ctx) => {
    const fx = await fixture();
    const dflt = path.join(home, ".motebit");
    if (!caseInsensitive(dflt)) ctx.skip();
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { agent: path.join(home, ".MOTEBIT") }), h.deps),
      /default motebit config directory/,
    );
  });

  it("--agent whose config.json is a hard link to the default config", async () => {
    const fx = await fixture();
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-agent-link-"));
    fs.linkSync(path.join(home, ".motebit", "config.json"), path.join(linked, "config.json"));
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { agent: linked }), h.deps),
      /default motebit config directory/,
    );
  });

  // A linked worktree's git directory and the common git directory lie
  // outside its root; the repository's other worktrees are the repository too.
  async function linkedWorktree(): Promise<{ fx: Fixture; wt: string }> {
    const fx = await fixture();
    git(fx.repo, "branch", "side");
    git(fx.repo, "checkout", "-q", "side");
    const wt = path.join(path.dirname(fx.repo), "wt");
    git(fx.repo, "worktree", "add", "-q", wt, "main");
    return { fx: { ...fx, repo: wt }, wt };
  }

  it("an output directory inside the common git directory of a linked worktree", async () => {
    const { fx } = await linkedWorktree();
    const refsHeads = path.join(gitCommonDir(fx.repo), "refs", "heads");
    const before = fs.readdirSync(refsHeads).sort();
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { output: refsHeads }), h.deps),
      /inside the repository/,
    );
    expect(fs.readdirSync(refsHeads).sort()).toEqual(before);
  });

  it("an output directory inside another worktree of the same repository", async () => {
    const { fx } = await linkedWorktree();
    const mainWorktree = path.dirname(gitCommonDir(fx.repo));
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { output: path.join(mainWorktree, "out") }), h.deps),
      /inside the repository/,
    );
    expect(fs.existsSync(path.join(mainWorktree, "out"))).toBe(false);
  });

  it("an output directory inside the main worktree of a repository with a separate git dir", async () => {
    const fx = await fixture();
    const store = path.join(path.dirname(fx.repo), "store.git");
    git(fx.repo, "init", "-q", `--separate-git-dir=${store}`);
    git(fx.repo, "branch", "side");
    git(fx.repo, "checkout", "-q", "side");
    const wt = path.join(path.dirname(fx.repo), "wt-sep");
    git(fx.repo, "worktree", "add", "-q", wt, "main");
    const h = harness();
    await expectRefusal(
      h,
      () =>
        handleRepoTaskRun(args({ ...fx, repo: wt }, { output: path.join(fx.repo, "out") }), h.deps),
      /inside the repository/,
    );
    expect(fs.existsSync(path.join(fx.repo, "out"))).toBe(false);
  });

  // A separate git directory sits under no worktree: only the git-directory
  // check (by filesystem identity) stands between --output and its refs.
  async function separateGitDir(): Promise<{ fx: Fixture; store: string }> {
    const fx = await fixture();
    const store = path.join(path.dirname(fx.repo), "store.git");
    git(fx.repo, "init", "-q", `--separate-git-dir=${store}`);
    return { fx, store };
  }

  it("an output directory inside a separate git directory", async () => {
    const { fx, store } = await separateGitDir();
    const heads = path.join(store, "refs", "heads");
    const before = fs.readdirSync(heads).sort();
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { output: heads }), h.deps),
      /inside the repository/,
    );
    expect(fs.readdirSync(heads).sort()).toEqual(before);
  });

  it("an output directory inside a separate git directory named by a case alias", async (ctx) => {
    const { fx, store } = await separateGitDir();
    if (!caseInsensitive(store)) ctx.skip();
    const heads = path.join(store, "refs", "heads");
    const before = fs.readdirSync(heads).sort();
    const alias = path.join(path.dirname(store), "STORE.git", "refs", "heads");
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { output: alias }), h.deps),
      /inside the repository/,
    );
    expect(fs.readdirSync(heads).sort()).toEqual(before);
  });

  // A symlink outside the repository whose target is inside it: the walk is
  // over the real path, never the caller's spelling.
  it("an output directory reached through a symlink to a subdirectory of the worktree", async () => {
    const fx = await fixture();
    const link = path.join(path.dirname(fx.repo), "link-into-worktree");
    fs.symlinkSync(path.join(fx.repo, "notes"), link);
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { output: path.join(link, "out") }), h.deps),
      /inside the repository/,
    );
    expect(fs.existsSync(path.join(fx.repo, "notes", "out"))).toBe(false);
  });

  it("an output directory reached through a symlink into a separate git directory", async () => {
    const { fx, store } = await separateGitDir();
    const link = path.join(path.dirname(store), "link-into-store");
    fs.symlinkSync(path.join(store, "refs"), link);
    const heads = path.join(store, "refs", "heads");
    const before = fs.readdirSync(heads).sort();
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { output: path.join(link, "heads") }), h.deps),
      /inside the repository/,
    );
    expect(fs.readdirSync(heads).sort()).toEqual(before);
  });

  it("an output directory inside a linked worktree moved without a repair", async () => {
    const fx = await fixture();
    const wt = path.join(path.dirname(fx.repo), "wt-old");
    git(fx.repo, "worktree", "add", "-q", "-b", "side", wt);
    const moved = path.join(path.dirname(fx.repo), "wt-moved");
    fs.renameSync(wt, moved);
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { output: path.join(moved, "out") }), h.deps),
      /inside the repository/,
    );
    expect(fs.existsSync(path.join(moved, "out"))).toBe(false);
  });

  it("an output directory naming the repository by a case alias", async (ctx) => {
    const fx = await fixture();
    if (!caseInsensitive(fx.repo)) ctx.skip();
    const alias = fx.repo.replace(/[a-z](?=[^/]*$)/, (c) => c.toUpperCase());
    const h = harness();
    await expectRefusal(
      h,
      () => handleRepoTaskRun(args(fx, { output: path.join(alias, "out") }), h.deps),
      /inside the repository/,
    );
    expect(fs.existsSync(path.join(fx.repo, "out"))).toBe(false);
  });
});

// -- What the tip says, never the filesystem -----------------------------------

describe("repo-task run: pins and policy are read from the tip's tree", () => {
  it("a policy edited in the worktree is not the policy", async () => {
    const fx = await fixture();
    fs.writeFileSync(
      path.join(fx.repo, ".motebit/repo-path-policy.json"),
      JSON.stringify({ spec: "motebit/repo-path-policy@1.0", include: ["**/*"], exclude: [] }),
    );
    const session = await openIsolatedGit({
      gitEntry: path.join(fx.repo, ".git"),
      objectFormat: "sha1",
    });
    try {
      const state = await readTipState(session, fx.tip, await listTree(session, fx.tip));
      expect(state.isPathPermitted(DOC)).toBe(true);
      expect(state.isPathPermitted("src/code.ts")).toBe(false);
    } finally {
      session.close();
    }
  });

  it("a pin edited in the worktree is not the pin", async () => {
    const fx = await fixture();
    fs.writeFileSync(path.join(fx.repo, ".motebit/principals/principal.md"), await identityFile(x));
    const session = await openIsolatedGit({
      gitEntry: path.join(fx.repo, ".git"),
      objectFormat: "sha1",
    });
    try {
      const state = await readTipState(session, fx.tip, await listTree(session, fx.tip));
      expect(state.principal).toEqual(f.pin);
    } finally {
      session.close();
    }
  });
});

// -- The agent's key -------------------------------------------------------------

describe("repo-task run: the agent's key is erased on every exit path", () => {
  const zeroed = (k: Uint8Array) => k.every((b) => b === 0);

  it("on success", async () => {
    const fx = await fixture();
    const h = harness();
    await handleRepoTaskRun(args(fx), h.deps);
    expect(h.loaded).toHaveLength(1);
    expect(h.erased).toEqual([h.loaded[0]]);
    expect(zeroed(h.loaded[0]!)).toBe(true);
    expect(h.events.filter((e) => e === "unlock" || e === "erase")).toEqual(["unlock", "erase"]);
  });

  it("on a refusal after the key is unlocked", async () => {
    const fx = await fixture();
    // The preflight's clock is inside the window; the run's own check is not.
    let n = 0;
    const h = harness({ now: () => (n++ === 0 ? NOW : NOW + 2 * HOUR) });
    await expect(handleRepoTaskRun(args(fx), h.deps)).rejects.toBeInstanceOf(ExitCalled);
    expect(h.provider.calls).toBe(0);
    expect(h.erased).toEqual([h.loaded[0]]);
    expect(zeroed(h.loaded[0]!)).toBe(true);
    expect(h.events.slice(-2)).toEqual(["erase", "exit 1"]);
  });

  it("on a thrown error", async () => {
    const fx = await fixture();
    const broken = scripted(FIX_TURNS);
    broken.generateStream = async function* () {
      broken.calls++;
      yield* [];
      throw new Error("the provider broke");
    };
    const h = harness({ provider: broken });
    await expect(handleRepoTaskRun(args(fx), h.deps)).rejects.toThrow(/the provider broke/);
    expect(h.erased).toEqual([h.loaded[0]]);
    expect(zeroed(h.loaded[0]!)).toBe(true);
    expect(h.events.at(-1)).toBe("erase");
  });
});
