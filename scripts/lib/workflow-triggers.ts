/**
 * workflow-triggers — one reader of a GitHub workflow's `on.push` block.
 *
 * Two external gates each hand-rolled this (#731): `check-deploy-freshness`
 * read `on.push.paths` to know what a service redeploys on (#720, after it
 * had ASSUMED those paths and been wrong in both directions for two days),
 * and `check-image-provenance` read `on.push.branches` and the absence of a
 * paths filter to know whether every push to main publishes an image. Same
 * file shape, divergent regexes — a workflow edit one accepted and the other
 * rejected would have given the two gates different answers about the same
 * trigger. This is the one answer.
 *
 * Deliberately not a YAML parser. The workflows this repo writes use exactly
 * two list forms — inline `[a, b]` and block `- "a"` — and comment lines sit
 * INSIDE those lists (`deploy-embed.yml` explains in prose why it has no
 * `packages/**` entry, right where one would go). A reader that understands
 * only those shapes and says so is safer than a dependency that understands
 * everything and is trusted for it. Anything outside those shapes reads as
 * "not understood", never as "absent".
 */
import { readFileSync } from "node:fs";

export type PushTrigger =
  /** The file could not be read, or has no `on:` block this reader understands. */
  | { readable: false }
  /** An `on:` block with no `push:` event. */
  | { readable: true; push: false }
  | {
      readable: true;
      push: true;
      /** `null` when the push block names no `branches:` (GitHub: every branch). */
      branches: string[] | null;
      /** `null` when no `paths:` filter (GitHub: every path). */
      paths: string[] | null;
      /** `null` when no `paths-ignore:` filter. */
      pathsIgnore: string[] | null;
    };

const KEY = /^([ \t]*)([A-Za-z_-]+):(.*)$/;
const COMMENT_OR_BLANK = /^\s*(#.*)?$/;

/** Strip one layer of matching quotes. */
function unquote(s: string): string {
  const t = s.trim();
  const m = /^(["'])(.*)\1$/.exec(t);
  return m ? m[2]! : t;
}

/**
 * The list under `lines[keyIndex]`: inline `[a, b]` on the key line, else the
 * `- item` lines that follow, skipping comments and blanks, ending at the first
 * line that is neither. An empty list reads as `[]`, never `null`.
 */
function listAt(lines: readonly string[], keyIndex: number): string[] {
  const key = KEY.exec(lines[keyIndex]!)!;
  const rest = key[3]!.trim();
  const inline = /^\[(.*)\]\s*(#.*)?$/.exec(rest);
  if (inline) {
    return inline[1]!
      .split(",")
      .map(unquote)
      .filter((x) => x.length > 0);
  }
  const items: string[] = [];
  for (let i = keyIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (COMMENT_OR_BLANK.test(line)) continue;
    const item = /^\s*-\s*(.+?)\s*(#.*)?$/.exec(line);
    if (!item) break;
    items.push(unquote(item[1]!));
  }
  return items;
}

/**
 * The `on.push` trigger of one workflow file. Block boundaries are indentation:
 * `on:` at column 0 runs to the next column-0 key; `push:` at two spaces runs
 * to the next two-space key.
 */
export function readPushTrigger(workflowFile: string): PushTrigger {
  let text: string;
  try {
    text = readFileSync(workflowFile, "utf-8");
  } catch {
    return { readable: false };
  }
  const lines = text.split("\n");
  const on = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  if (on < 0) return { readable: false };
  let onEnd = lines.findIndex((l, i) => i > on && /^[A-Za-z_-]+:/.test(l));
  if (onEnd < 0) onEnd = lines.length;

  const push = lines.findIndex((l, i) => i > on && i < onEnd && /^  push:\s*(#.*)?$/.test(l));
  if (push < 0) return { readable: true, push: false };
  let pushEnd = lines.findIndex((l, i) => i > push && i < onEnd && /^  [A-Za-z_-]+:/.test(l));
  if (pushEnd < 0) pushEnd = onEnd;

  let branches: string[] | null = null;
  let paths: string[] | null = null;
  let pathsIgnore: string[] | null = null;
  for (let i = push + 1; i < pushEnd; i++) {
    const m = KEY.exec(lines[i]!);
    if (!m || m[1]!.length !== 4) continue; // only the push block's own keys
    if (m[2] === "branches") branches = listAt(lines, i);
    else if (m[2] === "paths") paths = listAt(lines, i);
    else if (m[2] === "paths-ignore") pathsIgnore = listAt(lines, i);
  }
  return { readable: true, push: true, branches, paths, pathsIgnore };
}
