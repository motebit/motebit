/**
 * What a commit says about governed repo changes (spec/repo-change-v1.md §2,
 * §7, §7.2), read from the commit's TREE through the isolated git session,
 * never from a filesystem:
 *
 *   - the pins, typed by role: `.motebit/principals/principal.md` and
 *     `.motebit/principals/agents/*.md`, each an intact identity file whose
 *     `(motebit_id, public_key)` pair is the pin (checked by
 *     `@motebit/crypto`'s `verify` and `identityVerifyOutcome`, never through
 *     a time-windowed key check);
 *   - the revocations under `.motebit/revocations/`, parsed strictly: a file
 *     that is not a regular `<grant_id>.json` blob of strict UTF-8 JSON naming
 *     that `grant_id` is a FAILURE, handed with the rest to the verifier's
 *     strict revocation-set rule — so a malformed revocation never reads as
 *     "not revoked";
 *   - the path policy `.motebit/repo-path-policy.json`, interpreted by the
 *     verifier's one interpreter (`parseRepoPathPolicy`);
 *   - the spent status: the grant's bundle path ever existed on the commit's
 *     first-parent history.
 *
 * Both judges read these the same way: `motebit repo-task run` at the tip it
 * builds on (it refuses on any problem), and `motebit-verify repo-change` at
 * the trusted `--base` (a missing or unreadable pin is simply not a pin, so
 * the verdict fails closed; an unparsable policy means the change is not
 * judged, spec §7.2).
 *
 * Apache-2.0 (moved from the BUSL-1.1 CLI's repo-task preflight on
 * 2026-11-02). Imports: Node built-ins, `@motebit/crypto` and
 * `@motebit/verifier`, both Apache-2.0.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { identityVerifyOutcome, verify } from "@motebit/crypto";
import type { DelegationRevocation } from "@motebit/crypto";
import { REPO_PATH_POLICY_FILE, parseRepoPathPolicy } from "@motebit/verifier";
import type { RepoChangePin, RepoPathPolicy } from "@motebit/verifier";

import type { IsolatedGit } from "./session.js";
import { readBlob } from "./tree.js";
import type { TreeEntry } from "./tree.js";

/** Where the role-typed pins live. */
export const PRINCIPAL_PIN_FILE = ".motebit/principals/principal.md";
export const AGENT_PIN_DIR = ".motebit/principals/agents/";
/** Where the strictly parsed revocations live. */
export const REVOCATIONS_DIR = ".motebit/revocations/";
/** Where a grant's bundle lands (spec/repo-change-v1.md §3.6). */
export const BUNDLES_DIR = ".motebit/bundles/";

/** Where a grant's bundle lands: `.motebit/bundles/<grant_id>.json`. */
export function bundlePath(grantId: string): string {
  return `${BUNDLES_DIR}${grantId}.json`;
}

/** A lowercase UUID: a grant_id's one spelling. */
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `grantId` is a lowercase UUID, so it names a bundle path. */
export function isCanonicalGrantId(grantId: string): boolean {
  return GRANT_ID.test(grantId);
}

/** The repository state could not be established (a shallow history, a malformed grant id). */
export class RepoStateError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("; "));
    this.name = "RepoStateError";
  }
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(bytes: Uint8Array): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** The pin an identity file holds: its verified `(motebit_id, public_key)` pair. Throws when not intact. */
export async function pinFromIdentityFile(content: string, what: string): Promise<RepoChangePin> {
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

/** What one commit's tree says: pins, revocations, the path policy, and every rule that did not hold. */
export interface RepoState {
  /** The commit it was read at. */
  readonly commit: string;
  /** `null` when absent or not an intact identity file. */
  readonly principal: RepoChangePin | null;
  /** Every intact agent pin; a file that is not one is a problem, never a pin. */
  readonly agents: readonly RepoChangePin[];
  /** The strictly parsed revocations: well-formed files, and every file that failed. */
  readonly revocations: {
    readonly set: readonly DelegationRevocation[];
    readonly failures: readonly string[];
  };
  /** `null` when absent or unparsable: the change cannot be judged. */
  readonly policy: RepoPathPolicy | null;
  /** Every pin or policy rule that did not hold (empty when all held). */
  readonly problems: readonly string[];
}

/**
 * Read the pins, revocations and path policy from `commit`'s tree (`tree`, its
 * full listing), through the isolated session. Never throws for what the tree
 * holds: every rule that did not hold is named in `problems`.
 */
export async function readRepoState(
  git: IsolatedGit,
  commit: string,
  tree: readonly TreeEntry[],
): Promise<RepoState> {
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
  let principal: RepoChangePin | null = null;
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
  const agents: RepoChangePin[] = [];
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

  // -- The path policy: data at the commit, the verifier's one interpreter.
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

  return {
    commit,
    principal,
    agents,
    revocations: { set: set as DelegationRevocation[], failures },
    policy,
    problems: refusals,
  };
}

/**
 * Spent (spec §7): the grant's bundle path ever existed on `commit`'s
 * first-parent history. Git's commit-graph and grafts are ignored (they can
 * hide a parent), and a shallow repository is refused (`RepoStateError`):
 * its history is cut, so "never existed" cannot be established. `commonDir`
 * is the repository's common git directory (where `shallow` lives).
 */
export async function isGrantSpent(
  git: IsolatedGit,
  commit: string,
  grantId: string,
  commonDir: string,
): Promise<boolean> {
  if (!GRANT_ID.test(grantId)) {
    throw new RepoStateError([`grant_id ${JSON.stringify(grantId)} is not a lowercase UUID`]);
  }
  if (fs.existsSync(path.join(commonDir, "shallow"))) {
    throw new RepoStateError([
      "the repository is shallow: whether the grant was already spent cannot be established",
    ]);
  }
  const out = await git.run(
    [
      "-c",
      "core.commitGraph=false",
      "rev-list",
      "--first-parent",
      commit,
      "--",
      bundlePath(grantId),
    ],
    { env: { GIT_GRAFT_FILE: "/dev/null" } },
  );
  return out.toString("latin1").trim().length > 0;
}
