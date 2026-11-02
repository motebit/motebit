/**
 * Reading commits and trees through the isolated git session (`session.ts`):
 * a commit's full tree listing with git's own path bytes, a blob's bytes, a
 * commit's parents from its raw object, and git's blob id of some bytes
 * computed in-process.
 *
 * Apache-2.0 (moved from the BUSL-1.1 CLI's repo-task preflight and bundle
 * modules on 2026-11-02). Node built-ins only.
 */
import { createHash } from "node:crypto";

import type { IsolatedGit } from "./session.js";

/** One entry of a commit's full tree, as git records it (`ls-tree -r -z --full-tree`). */
export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  /** Git's own path bytes. */
  readonly path: Uint8Array;
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
export async function readBlob(git: IsolatedGit, oid: string): Promise<Uint8Array> {
  const bytes = await git.run(["cat-file", "blob", oid]);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A commit's parents, from its raw object. */
export async function commitParents(git: IsolatedGit, commit: string): Promise<string[]> {
  const raw = (await git.run(["cat-file", "commit", commit])).toString("latin1");
  const header = raw.slice(0, raw.indexOf("\n\n") >= 0 ? raw.indexOf("\n\n") : raw.length);
  return header
    .split("\n")
    .filter((l) => l.startsWith("parent "))
    .map((l) => l.slice("parent ".length));
}

/** Git's object id of a blob with these bytes, in the repository's object format. */
export function gitBlobId(bytes: Uint8Array, objectFormat: "sha1" | "sha256"): string {
  return createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** A path's bytes as a latin1 string: a byte-exact key, never a decoding. */
export function pathKey(p: Uint8Array): string {
  return Buffer.from(p).toString("latin1");
}
