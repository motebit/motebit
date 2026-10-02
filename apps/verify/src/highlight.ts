/**
 * JSON pane coloring by ROLE: the signed body, the signature, the public key, and
 * the suite. A tiny depth-tracking scanner over the raw text — every character is
 * kept (the segments concatenate back to the input), so the colored layer lines
 * up exactly under the editable textarea. Only the receipt's TOP-LEVEL fields set
 * a role; nested receipts are part of the signed body.
 */

export type JsonRole = "body" | "signature" | "key" | "suite" | "punct";

export interface Segment {
  readonly text: string;
  readonly role: JsonRole;
}

const ROLE_FOR_KEY: Record<string, JsonRole> = {
  signature: "signature",
  public_key: "key",
  suite: "suite",
};

export function highlightJson(text: string): Segment[] {
  const out: Segment[] = [];
  let depth = 0;
  let role: JsonRole = "punct";
  let buf = "";
  let bufRole: JsonRole = "punct";
  const push = (s: string, r: JsonRole): void => {
    if (r !== bufRole && buf) {
      out.push({ text: buf, role: bufRole });
      buf = "";
    }
    bufRole = r;
    buf += s;
  };
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      // Scan the full string literal.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const lit = text.slice(i, Math.min(j + 1, text.length));
      if (depth === 1 && expectKey) {
        let name = lit.slice(1, -1);
        try {
          name = JSON.parse(lit) as string;
        } catch {
          /* keep raw */
        }
        role = ROLE_FOR_KEY[name] ?? "body";
        expectKey = false;
      }
      push(lit, depth >= 1 ? role : "punct");
      i += lit.length;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      if (depth === 1) expectKey = c === "{";
      push(c, depth === 1 ? "punct" : role);
    } else if (c === "}" || c === "]") {
      push(c, depth === 1 ? "punct" : role);
      depth--;
    } else if (c === "," && depth === 1) {
      expectKey = true;
      push(c, "punct");
    } else {
      push(c, depth >= 1 && !/\s/.test(c) ? role : bufRole);
    }
    i++;
  }
  if (buf) out.push({ text: buf, role: bufRole });
  return out;
}
