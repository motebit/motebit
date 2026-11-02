/**
 * Raw objects, re-hashed: the offline reader of a landed governed change
 * (spec/repo-change-v1.md §9, "Offline on a landed change"; design of record
 * docs/proposals/governed-repo-change-v1.md § "The verifier": "offline, git's
 * object lookups are not trusted at all").
 *
 * Replace refs, grafts and a forged commit-graph can make git report a tree
 * or a parent that is not the real one, and a forged pack index or a loose
 * object at another object's path can make the store hand back the wrong
 * bytes. So nothing here asks git anything but "the bytes the store holds
 * under this id" (one `cat-file --batch` process with the commit-graph off,
 * grafts and replace objects ignored — `IsolatedGit.objectStream`), and:
 *
 *   - every object's bytes are re-hashed in-process as `<type> <size>\0<content>`
 *     with the object format's hash, and must equal the id asked for, with
 *     the type the caller expects; a mismatch throws (`ObjectStoreError`);
 *   - commits are parsed here (the tree, the parents, the author, the
 *     committer, in that order, each exactly where git writes it), so a
 *     first-parent chain is walked from the commits' own bytes, never by
 *     `rev-list`;
 *   - trees are parsed here and refused unless canonical: each mode one of
 *     git's five (`100644`, `100755`, `120000`, `160000`, `40000`), each name
 *     non-empty, without `/` or NUL and not `.` or `..`, no name twice, and
 *     the entries in git's order (by name, a tree compared as `<name>/`),
 *     strictly increasing.
 *
 * Every verified object is cached by id, so a long history reads each tree
 * once. Apache-2.0. Node built-ins only.
 */
import { createHash } from "node:crypto";

import type { IsolatedGit, ObjectStream } from "./session.js";
import type { TreeEntry } from "./tree.js";

/** The object store does not hold an object, or holds bytes that are not it. Never a verdict. */
export class ObjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

/** One entry of a tree object, as the tree's bytes hold it. */
export interface RawTreeEntry {
  /** The mode as stored (`40000` for a tree). */
  readonly mode: string;
  readonly name: Uint8Array;
  readonly oid: string;
}

/** A commit, parsed from its own bytes. */
export interface RawCommit {
  readonly oid: string;
  readonly tree: string;
  readonly parents: readonly string[];
  /** The `committer` header's value, raw (`<name> <<email>> <seconds> <tz>`). */
  readonly committer: string;
  /** The commit object's exact bytes (its id re-hashed from them). */
  readonly raw: Buffer;
}

const TREE_MODES: Readonly<Record<string, { mode: string; type: string }>> = {
  "100644": { mode: "100644", type: "blob" },
  "100755": { mode: "100755", type: "blob" },
  "120000": { mode: "120000", type: "blob" },
  "160000": { mode: "160000", type: "commit" },
  "40000": { mode: "040000", type: "tree" },
};

/** Git's object id of `<type> <size>\0<content>` in `objectFormat`. */
export function gitObjectId(
  type: string,
  content: Uint8Array,
  objectFormat: "sha1" | "sha256",
): string {
  return createHash(objectFormat)
    .update(`${type} ${content.length}\0`)
    .update(content)
    .digest("hex");
}

/** Compare two byte strings (git's `memcmp` order, shorter first on a tie). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** A tree entry's sort key: its name, and `/` after it when it is a tree. */
function sortKey(e: RawTreeEntry): Uint8Array {
  if (e.mode !== "40000") return e.name;
  const k = new Uint8Array(e.name.length + 1);
  k.set(e.name);
  k[e.name.length] = 0x2f;
  return k;
}

/** Parse a tree object's bytes strictly (canonical modes, names and order); throws `ObjectStoreError`. */
export function parseTree(oid: string, content: Uint8Array, hashLength: number): RawTreeEntry[] {
  const out: RawTreeEntry[] = [];
  const names = new Set<string>();
  let i = 0;
  while (i < content.length) {
    const sp = content.indexOf(0x20, i);
    if (sp < 0) throw new ObjectStoreError(`tree ${oid}: an entry has no mode`);
    const mode = Buffer.from(content.subarray(i, sp)).toString("latin1");
    if (!Object.hasOwn(TREE_MODES, mode)) {
      throw new ObjectStoreError(`tree ${oid}: mode ${JSON.stringify(mode)} is not canonical`);
    }
    const nul = content.indexOf(0x00, sp + 1);
    if (nul < 0) throw new ObjectStoreError(`tree ${oid}: an entry name is not terminated`);
    const name = content.subarray(sp + 1, nul);
    const nameKey = Buffer.from(name).toString("latin1");
    if (name.length === 0 || name.includes(0x2f) || nameKey === "." || nameKey === "..") {
      throw new ObjectStoreError(
        `tree ${oid}: the entry name ${JSON.stringify(nameKey)} is malformed`,
      );
    }
    if (nul + 1 + hashLength > content.length) {
      throw new ObjectStoreError(`tree ${oid}: an entry's object id is cut short`);
    }
    const entryOid = Buffer.from(content.subarray(nul + 1, nul + 1 + hashLength)).toString("hex");
    i = nul + 1 + hashLength;
    if (names.has(nameKey)) {
      throw new ObjectStoreError(`tree ${oid}: the name ${JSON.stringify(nameKey)} occurs twice`);
    }
    names.add(nameKey);
    const e: RawTreeEntry = { mode, name: new Uint8Array(name), oid: entryOid };
    const prev = out[out.length - 1];
    if (prev !== undefined && compareBytes(sortKey(prev), sortKey(e)) >= 0) {
      throw new ObjectStoreError(`tree ${oid}: the entries are not in git's canonical order`);
    }
    out.push(e);
  }
  return out;
}

const COMMITTER_LINE = /^committer ([^\n]*)$/;

/** Parse a commit object's header strictly: tree, parents, author, committer, in that order. */
export function parseCommit(oid: string, raw: Buffer, hashLength: number): RawCommit {
  const text = raw.toString("latin1");
  const end = text.indexOf("\n\n");
  const header = end >= 0 ? text.slice(0, end) : text.endsWith("\n") ? text.slice(0, -1) : null;
  if (header === null) throw new ObjectStoreError(`commit ${oid}: the header is not terminated`);
  const lines = header.split("\n");
  const hex = `[0-9a-f]{${hashLength * 2}}`;
  const treeM = new RegExp(`^tree (${hex})$`).exec(lines[0] ?? "");
  if (!treeM) throw new ObjectStoreError(`commit ${oid}: the first header is not its tree`);
  const parents: string[] = [];
  let k = 1;
  const parentRe = new RegExp(`^parent (${hex})$`);
  for (; k < lines.length; k++) {
    const m = parentRe.exec(lines[k]!);
    if (!m) break;
    parents.push(m[1]!);
  }
  if (!/^author [^\n]*$/.test(lines[k] ?? "")) {
    throw new ObjectStoreError(`commit ${oid}: the author does not follow the tree and parents`);
  }
  const committer = COMMITTER_LINE.exec(lines[k + 1] ?? "");
  if (!committer) {
    throw new ObjectStoreError(`commit ${oid}: the committer does not follow the author`);
  }
  for (const l of lines.slice(k + 2)) {
    if (/^(?:tree|parent|author|committer) /.test(l)) {
      throw new ObjectStoreError(`commit ${oid}: a ${l.split(" ")[0]} header out of place`);
    }
  }
  return { oid, tree: treeM[1]!, parents, committer: committer[1]!, raw };
}

/** The verified reader over one isolated session. Close it when done. */
export interface RawObjects {
  readonly objectFormat: "sha1" | "sha256";
  /** An object's bytes, re-hashed against `oid` and of type `type`; throws `ObjectStoreError`. */
  object(oid: string, type: "commit" | "tree" | "blob"): Promise<Buffer>;
  commit(oid: string): Promise<RawCommit>;
  tree(oid: string): Promise<readonly RawTreeEntry[]>;
  /** A blob's bytes, re-hashed (a bound function: pass it as a blob reader). */
  readonly blob: (oid: string) => Promise<Uint8Array>;
  /** Every non-tree entry under `treeOid`, recursively, as `ls-tree -r -z --full-tree` would list it. */
  listTree(treeOid: string): Promise<TreeEntry[]>;
  /** The entry at `path` (`/`-separated) under `treeOid`, or `null` when there is none. */
  lookup(treeOid: string, path: string): Promise<RawTreeEntry | null>;
  close(): void;
}

/** Open a verified raw-object reader on the session (`IsolatedGit.objectStream`). */
export function openRawObjects(git: IsolatedGit): RawObjects {
  const objectFormat = git.objectFormat as "sha1" | "sha256";
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new ObjectStoreError(`unsupported object format ${JSON.stringify(git.objectFormat)}`);
  }
  const hashLength = objectFormat === "sha1" ? 20 : 32;
  const stream: ObjectStream = git.objectStream();
  const bytes = new Map<string, Buffer>();
  const commits = new Map<string, RawCommit>();
  const trees = new Map<string, readonly RawTreeEntry[]>();

  const object = async (oid: string, type: "commit" | "tree" | "blob"): Promise<Buffer> => {
    const key = `${type} ${oid}`;
    const hit = bytes.get(key);
    if (hit !== undefined) return hit;
    if (oid.length !== hashLength * 2 || !/^[0-9a-f]+$/.test(oid)) {
      throw new ObjectStoreError(`${JSON.stringify(oid)} is not a full ${objectFormat} object id`);
    }
    const got = await stream.read(oid);
    if (got === null) throw new ObjectStoreError(`the repository does not hold ${type} ${oid}`);
    if (got.type !== type) {
      throw new ObjectStoreError(`${oid} is a ${got.type}, not a ${type}`);
    }
    if (gitObjectId(type, got.content, objectFormat) !== oid) {
      throw new ObjectStoreError(`the bytes the store holds for ${type} ${oid} do not hash to it`);
    }
    // Blobs can be large and are read once; only commits and trees are kept.
    if (type !== "blob") bytes.set(key, got.content);
    return got.content;
  };

  const commit = async (oid: string): Promise<RawCommit> => {
    const hit = commits.get(oid);
    if (hit !== undefined) return hit;
    const c = parseCommit(oid, await object(oid, "commit"), hashLength);
    commits.set(oid, c);
    return c;
  };

  const tree = async (oid: string): Promise<readonly RawTreeEntry[]> => {
    const hit = trees.get(oid);
    if (hit !== undefined) return hit;
    const t = parseTree(oid, await object(oid, "tree"), hashLength);
    trees.set(oid, t);
    return t;
  };

  const listTree = async (treeOid: string): Promise<TreeEntry[]> => {
    const out: TreeEntry[] = [];
    const walk = async (oid: string, prefix: Uint8Array): Promise<void> => {
      for (const e of await tree(oid)) {
        const p = new Uint8Array(prefix.length + e.name.length);
        p.set(prefix);
        p.set(e.name, prefix.length);
        const kind = TREE_MODES[e.mode]!;
        if (kind.type === "tree") {
          const dir = new Uint8Array(p.length + 1);
          dir.set(p);
          dir[p.length] = 0x2f;
          await walk(e.oid, dir);
        } else {
          out.push({ mode: kind.mode, type: kind.type, oid: e.oid, path: p });
        }
      }
    };
    await walk(treeOid, new Uint8Array());
    return out;
  };

  const lookup = async (treeOid: string, path: string): Promise<RawTreeEntry | null> => {
    const segments = path.split("/");
    let cur = treeOid;
    for (let i = 0; i < segments.length; i++) {
      const want = Buffer.from(segments[i]!, "utf8");
      const e = (await tree(cur)).find((x) => Buffer.from(x.name).equals(want));
      if (e === undefined) return null;
      if (i === segments.length - 1) return e;
      if (e.mode !== "40000") return null;
      cur = e.oid;
    }
    return null;
  };

  return {
    objectFormat,
    object,
    commit,
    tree,
    blob: async (oid) => new Uint8Array(await object(oid, "blob")),
    listTree,
    lookup,
    close: () => stream.close(),
  };
}
