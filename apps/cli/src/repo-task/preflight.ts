/**
 * The repo-task run's preflight — everything `motebit repo-task run` must
 * know about the repository before the first model call
 * (docs/proposals/governed-repo-change-v1.md § "The chain", step 4), read
 * from the TIP'S TREE through the isolated git session, never from the
 * filesystem:
 *
 *   - the pins, typed by role: `.motebit/principals/principal.md` and
 *     `.motebit/principals/agents/*.md`, each an intact identity file whose
 *     `(motebit_id, public_key)` pair is the pin — compared byte for byte by
 *     the verifier's party rule, never through a time-windowed key check;
 *   - the revocations under `.motebit/revocations/`, parsed strictly: a file
 *     that is not a regular `<grant_id>.json` blob of strict UTF-8 JSON naming
 *     that `grant_id` is a FAILURE, handed with the rest to the verifier's
 *     strict revocation-set rule (`checkRepoChangeRevocationSet`, run by
 *     `checkRepoTaskAuthority`) — so a malformed revocation refuses the run,
 *     never reads as "not revoked";
 *   - the path policy `.motebit/repo-path-policy.json`, interpreted by the
 *     verifier's one interpreter (`parseRepoPathPolicy`, spec §7.2) — a
 *     missing or unparsable policy is a refusal;
 *   - the spent status: the grant's bundle path ever existed on the tip's
 *     first-parent history;
 *   - the worktree is clean at the tip: every tracked path is in the worktree
 *     with the same type and mode, and its bytes hash (in-process, the scope's
 *     object format) to the tip's blob — read through no symlinked directory.
 *     The run never writes the worktree; this only proves the worktree the
 *     operator sees IS the tip the change is built on.
 *
 * Nothing here decides authority: the pieces fill `RepoTaskAuthorityBundle`,
 * and the run's authority law (`checkRepoTaskAuthority` → the verifier's own
 * rules) judges them.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { identityVerifyOutcome, verify } from "@motebit/identity-file";
import type { RepoTaskPin, RepoTaskRevocations } from "@motebit/runtime";
import { REPO_PATH_POLICY_FILE, isRepoPathPermitted, parseRepoPathPolicy } from "@motebit/verifier";
import type { RepoPathPolicy } from "@motebit/verifier";

import type { IsolatedGit } from "./git.js";

/** Where the role-typed pins live at the tip. */
export const PRINCIPAL_PIN_FILE = ".motebit/principals/principal.md";
export const AGENT_PIN_DIR = ".motebit/principals/agents/";
/** Where the strictly parsed revocations live at the tip. */
export const REVOCATIONS_DIR = ".motebit/revocations/";
/** Where a grant's bundle lands (spec/repo-change-v1.md §3.6). */
export const BUNDLES_DIR = ".motebit/bundles/";

/** One or more preflight rules did not hold; nothing ran. */
export class RepoTaskPreflightError extends Error {
  constructor(readonly refusals: readonly string[]) {
    super(`repo task preflight refused:\n${refusals.map((r) => `  ${r}`).join("\n")}`);
    this.name = "RepoTaskPreflightError";
  }
}

/** One entry of a commit's full tree, as git records it (`ls-tree -r -z --full-tree`). */
export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  /** Git's own path bytes. */
  readonly path: Uint8Array;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(bytes: Uint8Array): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** Every entry of `commit`'s tree, recursively, with git's own path bytes. */
export async function listTree(git: IsolatedGit, commit: string): Promise<TreeEntry[]> {
  const out = await git.run(["ls-tree", "-r", "-z", "--full-tree", commit]);
  const entries: TreeEntry[] = [];
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 0) continue;
    const rec = out.subarray(start, i);
    start = i + 1;
    const tab = rec.indexOf(0x09);
    if (tab < 0) throw new Error("ls-tree: a record has no path");
    const [mode, type, oid] = rec.subarray(0, tab).toString("latin1").split(" ");
    if (mode === undefined || type === undefined || oid === undefined) {
      throw new Error("ls-tree: a malformed record");
    }
    entries.push({ mode, type, oid, path: new Uint8Array(rec.subarray(tab + 1)) });
  }
  if (start !== out.length) throw new Error("ls-tree: the listing is not NUL-terminated");
  return entries;
}

/** A blob's bytes, through the isolated session. */
async function readBlob(git: IsolatedGit, oid: string): Promise<Uint8Array> {
  const bytes = await git.run(["cat-file", "blob", oid]);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The pin an identity file holds: its verified `(motebit_id, public_key)` pair. Throws when not intact. */
export async function pinFromIdentityFile(content: string, what: string): Promise<RepoTaskPin> {
  const result = await verify(content, { expectedType: "identity" });
  const outcome = identityVerifyOutcome(result);
  if (result.type !== "identity" || !outcome.valid || !result.identity) {
    throw new Error(
      `${what} is not an intact identity file (${outcome.error ?? "verification failed"})`,
    );
  }
  return {
    motebit_id: result.identity.motebit_id,
    public_key: result.identity.identity.public_key,
  };
}

/** What the tip says: pins, revocations, the path policy. */
export interface TipState {
  readonly principal: RepoTaskPin;
  readonly agents: readonly RepoTaskPin[];
  readonly revocations: RepoTaskRevocations;
  readonly policy: RepoPathPolicy;
  readonly isPathPermitted: (p: string) => boolean;
}

/**
 * Read the pins, revocations and path policy from the tip's tree (`tree`, the
 * full listing of `tip`), through the isolated session. Throws
 * `RepoTaskPreflightError` naming every rule that did not hold.
 */
export async function readTipState(
  git: IsolatedGit,
  tip: string,
  tree: readonly TreeEntry[],
): Promise<TipState> {
  const refusals: string[] = [];
  const byPath = new Map<string, TreeEntry>();
  for (const e of tree) {
    const p = decode(e.path);
    if (p !== null) byPath.set(p, e);
  }
  const regularBlob = (e: TreeEntry | undefined): e is TreeEntry =>
    e !== undefined && e.type === "blob" && e.mode === "100644";
  const text = async (e: TreeEntry): Promise<string | null> => decode(await readBlob(git, e.oid));

  // -- The principal pin.
  let principal: RepoTaskPin | null = null;
  const pf = byPath.get(PRINCIPAL_PIN_FILE);
  if (pf === undefined) refusals.push(`no principal pin at the tip (${PRINCIPAL_PIN_FILE})`);
  else if (!regularBlob(pf)) refusals.push(`${PRINCIPAL_PIN_FILE} is not a regular 100644 file`);
  else {
    const t = await text(pf);
    try {
      if (t === null) throw new Error(`${PRINCIPAL_PIN_FILE} is not UTF-8`);
      principal = await pinFromIdentityFile(t, PRINCIPAL_PIN_FILE);
    } catch (err) {
      refusals.push(err instanceof Error ? err.message : String(err));
    }
  }

  // -- The agent pins and the revocations: every entry under each directory.
  const agents: RepoTaskPin[] = [];
  const set: unknown[] = [];
  const failures: string[] = [];
  for (const e of tree) {
    const p = decode(e.path);
    const raw = Buffer.from(e.path).toString("latin1");
    if (raw.startsWith(AGENT_PIN_DIR)) {
      const name = p?.slice(AGENT_PIN_DIR.length);
      if (p === null || name === undefined || name.includes("/") || !/^[^/]+\.md$/.test(name)) {
        refusals.push(`${JSON.stringify(raw)} is not an agent pin file (<name>.md)`);
      } else if (!regularBlob(e)) {
        refusals.push(`${p} is not a regular 100644 file`);
      } else {
        const t = await text(e);
        try {
          if (t === null) throw new Error(`${p} is not UTF-8`);
          agents.push(await pinFromIdentityFile(t, p));
        } catch (err) {
          refusals.push(err instanceof Error ? err.message : String(err));
        }
      }
    } else if (raw.startsWith(REVOCATIONS_DIR)) {
      // Every file here either parses strictly or is a failure — never skipped.
      const name = p?.slice(REVOCATIONS_DIR.length);
      if (p === null || name === undefined || name.includes("/") || !name.endsWith(".json")) {
        failures.push(`${JSON.stringify(raw)} is not a <grant_id>.json file`);
        continue;
      }
      if (!regularBlob(e)) {
        failures.push(`${p} is not a regular 100644 file`);
        continue;
      }
      const t = await text(e);
      let value: unknown;
      try {
        if (t === null) throw new Error("not UTF-8");
        value = JSON.parse(t) as unknown;
      } catch {
        failures.push(`${p} is not UTF-8 JSON`);
        continue;
      }
      const grantId =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as { grant_id?: unknown }).grant_id
          : undefined;
      if (typeof grantId !== "string" || `${grantId}.json` !== name) {
        failures.push(`${p}: the file name is not its revocation's grant_id`);
        continue;
      }
      set.push(value);
    }
  }
  if (agents.length === 0 && !refusals.some((r) => r.includes(AGENT_PIN_DIR))) {
    refusals.push(`no agent pin at the tip (${AGENT_PIN_DIR}*.md)`);
  }

  // -- The path policy: data at the tip, the verifier's one interpreter.
  let policy: RepoPathPolicy | null = null;
  const pol = byPath.get(REPO_PATH_POLICY_FILE);
  if (pol === undefined) refusals.push(`no path policy at the tip (${REPO_PATH_POLICY_FILE})`);
  else if (!regularBlob(pol))
    refusals.push(`${REPO_PATH_POLICY_FILE} is not a regular 100644 file`);
  else {
    const t = await text(pol);
    try {
      if (t === null) throw new Error("not UTF-8");
      policy = parseRepoPathPolicy(t);
    } catch (err) {
      refusals.push(
        `${REPO_PATH_POLICY_FILE} does not parse: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (refusals.length > 0 || principal === null || policy === null) {
    throw new RepoTaskPreflightError(refusals);
  }
  const parsed = policy;
  return {
    principal,
    agents,
    revocations: {
      set: set as RepoTaskRevocations["set"],
      failures,
      readAt: tip,
    },
    policy: parsed,
    isPathPermitted: (p: string) => isRepoPathPermitted(parsed, p),
  };
}

/**
 * Spent (spec §7): the grant's bundle path ever existed on the tip's
 * first-parent history. Git's commit-graph and grafts are ignored (they can
 * hide a parent), and a shallow repository is refused: its history is cut,
 * so "never existed" cannot be established.
 */
export async function isGrantSpentAtTip(
  git: IsolatedGit,
  tip: string,
  grantId: string,
  commonDir: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(grantId)) {
    throw new RepoTaskPreflightError([
      `grant_id ${JSON.stringify(grantId)} is not a lowercase UUID`,
    ]);
  }
  if (fs.existsSync(path.join(commonDir, "shallow"))) {
    throw new RepoTaskPreflightError([
      "the repository is shallow: whether the grant was already spent cannot be established",
    ]);
  }
  const out = await git.run(
    [
      "-c",
      "core.commitGraph=false",
      "rev-list",
      "--first-parent",
      tip,
      "--",
      `${BUNDLES_DIR}${grantId}.json`,
    ],
    { env: { GIT_GRAFT_FILE: "/dev/null" } },
  );
  return out.toString("latin1").trim().length > 0;
}

/** Git's object id of a blob with these bytes, in the repository's object format. */
export function gitBlobId(bytes: Uint8Array, objectFormat: "sha1" | "sha256"): string {
  return createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * The worktree is clean at the tip: for every tracked path, the worktree
 * entry exists with the same type and mode, reached through real directories
 * only, and its bytes (a symlink's target) hash to the tip's blob. A gitlink
 * is refused: a submodule's checkout cannot be proven to be the recorded
 * commit without running git in it. Returns every difference (empty = clean).
 */
export function worktreeDifferences(
  repoDir: string,
  tree: readonly TreeEntry[],
  objectFormat: "sha1" | "sha256",
): string[] {
  const out: string[] = [];
  const root = Buffer.from(path.resolve(repoDir));
  const realDirs = new Set<string>();
  const sep = Buffer.from("/");
  for (const e of tree) {
    const rel = Buffer.from(e.path);
    const label = JSON.stringify(rel.toString("utf8"));
    // Every directory on the way must be a real directory, not a symlink.
    let dirOk = true;
    for (let i = rel.indexOf(0x2f); i >= 0; i = rel.indexOf(0x2f, i + 1)) {
      const prefix = rel.subarray(0, i);
      const key = prefix.toString("latin1");
      if (realDirs.has(key)) continue;
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(Buffer.concat([root, sep, prefix]));
      } catch {
        st = null;
      }
      if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
        dirOk = false;
        break;
      }
      realDirs.add(key);
    }
    if (!dirOk) {
      out.push(`${label}: a directory on its path is missing or not a real directory`);
      continue;
    }
    const full = Buffer.concat([root, sep, rel]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      out.push(`${label}: missing from the worktree`);
      continue;
    }
    if (e.mode === "100644" || e.mode === "100755") {
      if (!st.isFile()) {
        out.push(`${label}: not a regular file in the worktree (tracked ${e.mode})`);
        continue;
      }
      const executable = (st.mode & 0o100) !== 0;
      if (executable !== (e.mode === "100755")) {
        out.push(`${label}: mode differs from the tip's ${e.mode}`);
        continue;
      }
      if (gitBlobId(fs.readFileSync(full), objectFormat) !== e.oid) {
        out.push(`${label}: content differs from the tip`);
      }
    } else if (e.mode === "120000") {
      if (!st.isSymbolicLink()) {
        out.push(`${label}: not a symlink in the worktree (tracked 120000)`);
        continue;
      }
      if (gitBlobId(fs.readlinkSync(full, { encoding: "buffer" }), objectFormat) !== e.oid) {
        out.push(`${label}: symlink target differs from the tip`);
      }
    } else if (e.mode === "160000") {
      out.push(`${label}: a submodule cannot be proven clean`);
    } else {
      out.push(`${label}: unexpected tracked mode ${e.mode}`);
    }
  }
  return out;
}
