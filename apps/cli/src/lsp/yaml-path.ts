/**
 * Position → yaml path resolution for the LSP.
 *
 * The `yaml` package parses to a CST whose nodes expose byte-offset ranges
 * `[start, valueEnd, nodeEnd]`. Given a cursor offset, we walk the CST and
 * return the path of keys (and array indices) from root to the node under
 * the cursor — the same shape zod uses for `issue.path`, so the hover/
 * completion logic can reuse the schema-walker without translation.
 *
 * Sharp edge noted in scope: ranges are byte offsets, LSP positions are
 * UTF-16 character offsets. TextDocument.offsetAt returns UTF-16 units. For
 * ASCII yaml (the overwhelming common case) these coincide. Non-ASCII
 * comments are off by a known factor; MVP accepts this and leaves a hook.
 */

import type { Document, Node, Pair, Scalar } from "yaml";
import { isMap, isSeq, isScalar } from "yaml";

export interface CursorContext {
  /** Path from document root to the node under the cursor. */
  path: (string | number)[];
  /**
   * True if the cursor lands on a map's key rather than its value. Hover
   * text for a `routines:` keyword is the `routines` field description,
   * not the array-element description.
   */
  onKey: boolean;
}

/** Walk the yaml CST and find the path at `offset`. */
export function findPathAtOffset(doc: Document.Parsed, offset: number): CursorContext | null {
  return walk(doc.contents as Node | null, offset, []);
}

function walk(node: Node | null, offset: number, path: (string | number)[]): CursorContext | null {
  if (node == null) return null;
  if (isMap(node)) {
    for (const pair of node.items as Pair<Node, Node | null>[]) {
      const key = pair.key as Scalar | null;
      const value = pair.value;
      const keyName = key != null && isScalar(key) ? String(key.value) : null;
      const keyRange = key?.range;
      if (keyRange && offset >= keyRange[0] && offset <= keyRange[1]) {
        return { path: keyName != null ? [...path, keyName] : path, onKey: true };
      }
      const valueRange = value?.range;
      if (value && keyName != null && valueRange) {
        if (offset >= valueRange[0] && offset <= valueRange[2]) {
          const inner = walk(value, offset, [...path, keyName]);
          if (inner) return inner;
          return { path: [...path, keyName], onKey: false };
        }
      }
    }
    return path.length > 0 ? { path, onKey: false } : null;
  }
  if (isSeq(node)) {
    for (let i = 0; i < node.items.length; i++) {
      const item = node.items[i] as Node | null;
      const range = item?.range;
      if (range && offset >= range[0] && offset <= range[2]) {
        const inner = walk(item, offset, [...path, i]);
        if (inner) return inner;
        return { path: [...path, i], onKey: false };
      }
    }
    return path.length > 0 ? { path, onKey: false } : null;
  }
  return null;
}
