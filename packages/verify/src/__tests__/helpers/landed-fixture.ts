/**
 * A landed governed change, for the offline mode of `motebit-verify
 * repo-change`: the CI fixture's pull request (`repo-change-fixture.ts`),
 * squash-landed on `main` the way GitHub's merge queue lands it — one commit
 * whose tree is the pull request head's, whose only parent is the tip it was
 * built on, committed by `GitHub <noreply@github.com>` and signed by a test
 * stand-in for GitHub's key (`github-signer.ts`), written with `git
 * hash-object --literally`. A later commit on `main` is the trusted tip.
 *
 * Every knob changes one thing about the landing, so each failing test names
 * one rule.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { NOW, fixture, git, gitEnv } from "./repo-change-fixture.js";
import type { Fixture, FixtureOptions } from "./repo-change-fixture.js";
import { commitPayload, signPayload, testSigningKey, withSignature } from "./github-signer.js";
import type { SignOptions, TestSigningKey } from "./github-signer.js";

/** The committer time of a landing inside the fixture grant's window. */
export const LANDED_SECONDS = Math.floor(NOW / 1000);
/** GitHub signs a squash commit seconds after its committer time (15–17 s on motebit's main). */
export const SIGN_DELAY = 16;

let pinnedKey: TestSigningKey | null = null;
/** The test stand-in for GitHub's signing key: the one the pinned-keys file holds. */
export function pinned(): TestSigningKey {
  if (pinnedKey === null) pinnedKey = testSigningKey();
  return pinnedKey;
}
/** A `motebit/operator-signing-keys@1.0` file pinning `entries` (each window open unless `trustedUntil`). */
export function pinFile(
  entries: readonly { readonly key: TestSigningKey; readonly trustedUntil?: number | null }[],
): string {
  return `${JSON.stringify(
    {
      spec: "motebit/operator-signing-keys@1.0",
      keys: entries.map((e) => ({
        fingerprint: e.key.fingerprint,
        armored: e.key.armored,
        trusted_until: e.trustedUntil ?? null,
      })),
    },
    null,
    2,
  )}\n`;
}
let otherKey: TestSigningKey | null = null;
/** A key nobody pinned. */
export function stranger(): TestSigningKey {
  if (otherKey === null) otherKey = testSigningKey();
  return otherKey;
}

export interface LandedOptions extends FixtureOptions {
  /** The committer `<name> <<email>>` (default GitHub's). */
  committer?: string;
  /** Signature knobs, or `false` for no `gpgsig` at all. */
  sign?: SignOptions | false;
  /** Who signs (default the pinned key). */
  signer?: TestSigningKey;
  /** Files the squash commit writes besides the pull request's tree. */
  squashExtra?: Record<string, string>;
  /** Replace the squash commit's tree (given the pull request head's tree). */
  squashTree?: (repo: string, headTree: string) => string;
  /** A second parent (the pull request's change commit). */
  extraParent?: boolean;
  /** Land on a copy of the base with no history: parent_commit is then not its ancestor. */
  orphanParent?: boolean;
  /** The trusted tip is a merge whose FIRST parent is the base: the squash commit is only on its side. */
  sideBranch?: boolean;
  /** Rewrite the signed commit's bytes before it is written. */
  raw?: (b: Buffer) => Buffer;
}

export interface LandedFixture extends Fixture {
  readonly squash: string;
  readonly parent: string;
  readonly tip: string;
  readonly keysFile: string;
  readonly keys: string;
}

/** Run git with stdin (test setup only). */
export function gitIn(
  repo: string,
  args: string[],
  input?: Buffer | string,
  env: Record<string, string> = {},
): string {
  return execFileSync("git", args, {
    cwd: repo,
    env: gitEnv(env),
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

/** A tree: `base` with `files` written (via a private index). */
export function treeWith(repo: string, base: string, files: Record<string, string>): string {
  const idx = { GIT_INDEX_FILE: path.join(repo, ".git", `idx-${crypto.randomUUID()}`) };
  gitIn(repo, ["read-tree", base], undefined, idx);
  for (const [p, c] of Object.entries(files)) {
    const blob = gitIn(repo, ["hash-object", "-w", "--stdin"], c);
    gitIn(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${p}`], undefined, idx);
  }
  return gitIn(repo, ["write-tree"], undefined, idx);
}

/** Write a raw commit object, as the merge queue would have. */
export function writeCommit(repo: string, raw: Buffer): string {
  return gitIn(repo, ["hash-object", "-w", "-t", "commit", "--literally", "--stdin"], raw);
}

/** Build a fixture repository holding a squash-landed governed change. */
export async function landedFixture(root: string, o: LandedOptions = {}): Promise<LandedFixture> {
  const fx = await fixture(root, o);
  const { repo } = fx;
  const headTree = git(repo, "rev-parse", `${fx.head}^{tree}`);
  let tree = o.squashTree ? o.squashTree(repo, headTree) : headTree;
  if (o.squashExtra) tree = treeWith(repo, tree, o.squashExtra);
  const parent = o.orphanParent
    ? gitIn(repo, ["commit-tree", `${fx.base}^{tree}`, "-m", "orphan"])
    : fx.base;
  const parents = o.extraParent ? [parent, fx.change] : [parent];
  const payload = commitPayload({
    tree,
    parents,
    seconds: LANDED_SECONDS,
    ...(o.committer !== undefined ? { committer: o.committer } : {}),
  });
  let raw =
    o.sign === false
      ? payload
      : withSignature(
          payload,
          signPayload(payload, o.signer ?? pinned(), LANDED_SECONDS + SIGN_DELAY, o.sign ?? {}),
        );
  if (o.raw) raw = o.raw(raw);
  const squash = writeCommit(repo, raw);
  const tip = o.sideBranch
    ? gitIn(repo, ["commit-tree", `${fx.base}^{tree}`, "-p", fx.base, "-p", squash, "-m", "merge"])
    : gitIn(repo, ["commit-tree", `${squash}^{tree}`, "-p", squash, "-m", "later"]);
  gitIn(repo, ["update-ref", "refs/heads/main", tip]);
  const keys = pinFile([{ key: pinned() }]);
  const keysFile = path.join(root, `keys-${crypto.randomUUID()}.json`);
  fs.writeFileSync(keysFile, keys);
  return { ...fx, squash, parent, tip, keysFile, keys };
}
