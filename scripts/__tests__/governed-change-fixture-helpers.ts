/**
 * Helpers for governed-change-fixture.test.ts: throwaway repositories, the
 * principal F and the agent A as ephemeral identities, a harness over the
 * fixture's deps, and the repository-state snapshots the tests compare.
 * Modelled on apps/cli/src/repo-task/__tests__/run-command.test.ts.
 *
 * The `@motebit/*` packages are loaded through the CLI's dependency graph,
 * as the script loads them (the repository root does not depend on them).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { StreamingProvider } from "@motebit/ai-core";
import type { KeyPair } from "@motebit/encryption";
import type { RepoTaskPin } from "@motebit/runtime";
import type { AIResponse, ToolCall } from "@motebit/sdk";

import { encryptPrivateKey, loadActiveSigningKey } from "../../apps/cli/src/identity.js";
import { defaultConfigDirs } from "../../apps/cli/src/repo-task/agent-identity.js";
import {
  delegateToDirectory,
  mintRepoTaskRevocation,
} from "../../apps/cli/src/repo-task/delegation.js";
import { runGovernedRepoTask } from "../../apps/cli/src/repo-task/run-command.js";
import type { FixtureCommandDeps } from "../governed-change-fixture.js";
import { cleanEnv } from "../lib/differential-tree.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliRequire = createRequire(path.join(ROOT, "apps", "cli", "package.json"));

export async function fromCli<T>(specifier: string): Promise<T> {
  return (await import(pathToFileURL(cliRequire.resolve(specifier)).href)) as T;
}

export const encryption = (): Promise<typeof import("@motebit/encryption")> =>
  fromCli("@motebit/encryption");
export const verifyGit = (): Promise<typeof import("@motebit/verify/git")> =>
  fromCli("@motebit/verify/git");
export const identityFile = (): Promise<typeof import("@motebit/identity-file")> =>
  fromCli("@motebit/identity-file");

export const NOW = 1_900_000_000_000;
export const HOUR = 3_600_000;
export const REPO = "motebit/motebit";
export const PASS = "agent passphrase";
export const DOC = "notes/guide.md";
export const OUTSIDE = "notes/governed-change-fixture-b3.md";
export const POLICY = JSON.stringify({
  spec: "motebit/repo-path-policy@1.0",
  include: ["notes/*.md"],
  exclude: [".motebit"],
});

export class ExitCalled extends Error {}

export interface Party {
  keys: KeyPair;
  pin: RepoTaskPin;
}

export async function party(): Promise<Party> {
  const enc = await encryption();
  const keys = await enc.generateKeypair();
  const public_key = enc.bytesToHex(keys.publicKey);
  return { keys, pin: { motebit_id: await enc.deriveSovereignMotebitId(public_key), public_key } };
}

async function identityFileOf(p: Party): Promise<string> {
  const { generate } = await identityFile();
  return generate(
    { motebitId: p.pin.motebit_id, ownerId: "owner", publicKeyHex: p.pin.public_key },
    p.keys.privateKey,
  );
}

export async function agentConfigOf(a: Party): Promise<Record<string, unknown>> {
  const enc = await encryption();
  return {
    motebit_id: a.pin.motebit_id,
    device_id: "agent-device",
    device_public_key: a.pin.public_key,
    cli_encrypted_key: await encryptPrivateKey(enc.bytesToHex(a.keys.privateKey), PASS),
    // Fields a run must never read.
    personality: { name: "should-not-load" },
    mcp_servers: [{ name: "evil", command: "/bin/false" }],
  };
}

/** The fixture git's whole environment: nothing inherited but PATH (cleanEnv scrubs every GIT_*). */
export function gitVars(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
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

export function git(home: string, repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    env: cleanEnv({}, gitVars(home)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function gitBytes(home: string, repo: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: repo, env: cleanEnv({}, gitVars(home)) });
}

function writeFile(repo: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
}

/** A scripted model: each turn's tool calls, then a final answer. */
export function scripted(turns: ToolCall[][]): StreamingProvider {
  let n = 0;
  const respond = (): AIResponse => {
    const calls = turns[n++];
    return calls
      ? { text: "", confidence: 1, memory_candidates: [], state_updates: {}, tool_calls: calls }
      : { text: "Fixed.", confidence: 1, memory_candidates: [], state_updates: {} };
  };
  return {
    model: "scripted-model",
    setModel: () => {},
    generate: async () => respond(),
    estimateConfidence: async () => 1,
    extractMemoryCandidates: async () => [],
    async *generateStream() {
      yield { type: "done" as const, response: respond() };
    },
  } as unknown as StreamingProvider;
}

export const FIX_TURNS: ToolCall[][] = [
  [{ id: "1", name: "repo_read_blob", args: { path: DOC } }],
  [{ id: "2", name: "repo_write_path", args: { path: DOC, content: "the typo\n" } }],
];

export interface Env {
  home: string;
  f: Party;
  a: Party;
  agentDir: string;
}

export interface FixtureRepoOptions {
  /** Default 2 (b3 adds one path to the change). */
  maxChangedFiles?: number;
  /** A revocation of the grant lands on main after the init commit (b6). */
  revoked?: boolean;
  /** A real governed change under the grant lands on main first (b5b). */
  landed?: boolean;
}

export interface FixtureRepo {
  root: string;
  repo: string;
  delegation: string;
  grantId: string;
  tip: string;
}

/** A throwaway repository on `main` and a delegation from F to A for DOC. */
export async function fixtureRepo(
  env: Env,
  tmp: string,
  o: FixtureRepoOptions = {},
): Promise<FixtureRepo> {
  const { f, a, home } = env;
  const root = fs.mkdtempSync(path.join(tmp, "fx-"));
  const repo = path.join(root, "repo");
  const delegation = path.join(root, "delegation");
  const grantId = crypto.randomUUID();
  const principal = {
    motebitId: f.pin.motebit_id,
    publicKeyHex: f.pin.public_key,
    privateKey: f.keys.privateKey,
  };
  await delegateToDirectory(
    {
      principal,
      delegate: a.pin,
      repo: REPO,
      baseRef: "main",
      objectFormat: "sha1",
      allowedPaths: [DOC],
      maxChangedFiles: o.maxChangedFiles ?? 2,
      task: "Fix the typo in notes/guide.md.",
      tools: "repo_read_blob,repo_write_path",
      lifetimeMs: HOUR,
      now: NOW - 60_000,
      grantId,
    },
    delegation,
  );
  fs.mkdirSync(repo);
  git(home, repo, "init", "-q", "-b", "main");
  writeFile(repo, DOC, "teh typo\n");
  writeFile(repo, "src/code.ts", "export const x = 1;\n");
  writeFile(repo, ".motebit/principals/principal.md", await identityFileOf(f));
  writeFile(
    repo,
    `.motebit/principals/agents/${a.pin.motebit_id.slice(0, 12)}.md`,
    await identityFileOf(a),
  );
  writeFile(repo, ".motebit/repo-path-policy.json", POLICY);
  git(home, repo, "add", "-A");
  git(home, repo, "commit", "-q", "-m", "init");
  if (o.landed) {
    // A real `repo-task run` under the grant, its bundle commit landed on main.
    const report = await runGovernedRepoTask(
      { agentDir: env.agentDir, delegationDir: delegation, repoDir: repo, providerName: "test" },
      {
        loadActiveSigningKey: (c, opts) => loadActiveSigningKey(c, opts),
        secureErase: (k) => k.fill(0),
        createProvider: () => scripted(FIX_TURNS),
        getPassphrase: async () => PASS,
        defaultConfigDirs: () => defaultConfigDirs(),
        now: () => NOW - 30_000,
        runtimeVersion: "motebit test",
      },
    );
    if (!report.accepted) throw new Error("the landing run did not verify");
    git(home, repo, "merge", "-q", "--ff-only", report.bundleCommit);
  }
  if (o.revoked) {
    const rev = await mintRepoTaskRevocation({
      target: {
        grant_id: grantId,
        delegator_id: f.pin.motebit_id,
        delegator_public_key: f.pin.public_key,
      },
      principal,
      now: NOW - 1000,
    });
    const { canonicalJson } = await encryption();
    writeFile(repo, `.motebit/revocations/${grantId}.json`, canonicalJson(rev));
    git(home, repo, "add", "-A");
    git(home, repo, "commit", "-q", "-m", "revoke");
  }
  return { root, repo, delegation, grantId, tip: git(home, repo, "rev-parse", "HEAD") };
}

export interface Harness {
  deps: FixtureCommandDeps;
  events: string[];
  lines: string[];
  errors: string[];
  /** Every config loadActiveSigningKey was handed. */
  configs: Record<string, unknown>[];
  loaded: Uint8Array[];
  ephemeral: Uint8Array[];
  erased: Uint8Array[];
}

/**
 * The fixture's deps with every key operation watched. `now` defaults to
 * NOW; `onErase` lets a test move the clock once a key is erased.
 */
export function harness(o: { now?: () => number; onErase?: () => void } = {}): Harness {
  const events: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const configs: Record<string, unknown>[] = [];
  const loaded: Uint8Array[] = [];
  const ephemeral: Uint8Array[] = [];
  const erased: Uint8Array[] = [];
  const deps: FixtureCommandDeps = {
    loadActiveSigningKey: async (c, opts) => {
      events.push("unlock");
      configs.push({ ...c });
      const k = await loadActiveSigningKey(c, opts);
      loaded.push(k.privateKey);
      return k;
    },
    secureErase: (key) => {
      events.push("erase");
      erased.push(key);
      key.fill(0);
      o.onErase?.();
    },
    getPassphrase: async () => PASS,
    ephemeralKeypair: async () => {
      events.push("ephemeral");
      const k = await (await encryption()).generateKeypair();
      ephemeral.push(k.privateKey);
      return k;
    },
    defaultConfigDirs: () => defaultConfigDirs(),
    now: o.now ?? (() => NOW),
    runtimeVersion: "motebit test",
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    exit: (code) => {
      events.push(`exit ${code}`);
      throw new ExitCalled(String(code));
    },
  };
  return { deps, events, lines, errors, configs, loaded, ephemeral, erased };
}

export function fixtureArgs(
  env: Env,
  fx: FixtureRepo,
  c: string,
  over: { output?: string; author?: string } = {},
): string[] {
  return [
    "--case",
    c,
    "--agent",
    env.agentDir,
    "--delegation",
    fx.delegation,
    "--repo",
    fx.repo,
    ...(over.output !== undefined ? ["--output", over.output] : []),
    ...(over.author !== undefined ? ["--author", over.author] : []),
  ];
}

/** A `  name  value` line of the output. */
export function field(lines: readonly string[], name: string): string {
  const line = lines.find((l) => l.trim().startsWith(name));
  if (line === undefined) throw new Error(`no ${name} line`);
  return line.trim().split(/\s+/)[1]!;
}

/** Every file under `dir` (excluding `.git`) → its bytes. */
export function snapshot(dir: string): Map<string, string> {
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
export function refState(home: string, repo: string): Map<string, string> {
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
  out.set("for-each-ref", git(home, repo, "for-each-ref", "--format=%(refname) %(objectname)"));
  return out;
}

/** The `~/.motebit` of the redirected home: its stat, never its content. */
export function homeState(home: string): string {
  const dir = path.join(home, ".motebit");
  const st = (p: string) => {
    const s = fs.lstatSync(p);
    return `${s.mode}:${s.size}:${s.mtimeMs}`;
  };
  return [st(dir), ...fs.readdirSync(dir).map((n) => `${n}=${st(path.join(dir, n))}`)].join("|");
}
