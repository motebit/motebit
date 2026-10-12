/**
 * codeowners — a small, pure model of GitHub CODEOWNERS matching, enough for
 * `check-codeowners-authority` to ask "who owns this repo path?" offline.
 *
 * Semantics implemented (docs.github.com, "About code owners"):
 *   - One rule per non-blank, non-`#` line: `<pattern> [owner ...]`. A pattern
 *     with NO owners is legal and makes matching paths unowned.
 *   - The LAST matching rule wins (a later rule fully replaces an earlier one).
 *   - Patterns follow gitignore matching, minus the parts CODEOWNERS refuses
 *     (`!` negation, `[ ]` ranges, `\#` escapes — refused here, not guessed):
 *       * a leading `/` anchors to the repo root; a `/` elsewhere in the
 *         pattern (other than trailing) also anchors it;
 *       * an unanchored pattern matches at any depth;
 *       * a trailing `/` matches only a directory, i.e. everything under it;
 *         without one, a pattern that names a directory also covers its contents;
 *       * `*` matches within one path segment, `?` one non-`/` char, `**`
 *         across segments.
 *
 * Paths are repo-relative with `/` separators and no leading `/`.
 */

export interface CodeownersRule {
  /** 1-based line in the CODEOWNERS file. */
  line: number;
  pattern: string;
  owners: string[];
  regex: RegExp;
}

export interface ParsedCodeowners {
  rules: CodeownersRule[];
  /** Lines the parser refused, with the reason (unsupported syntax). */
  errors: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, "\\$&");
}

/** Translate one CODEOWNERS pattern into an anchored regex over repo paths. */
export function patternToRegex(pattern: string): RegExp {
  let p = pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\/+/, "");

  let body = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*") {
      const atStart = i === 0;
      const followedBySlash = p[i + 2] === "/";
      if (followedBySlash) {
        // `**/` — zero or more leading directories.
        body += "(?:.*/)?";
        i += 2;
      } else if (atStart || p[i - 1] === "/") {
        // trailing `/**` or a bare `**` segment — anything, across segments.
        body += ".*";
        i += 1;
      } else {
        body += "[^/]*";
        i += 1;
      }
    } else if (c === "*") {
      body += "[^/]*";
    } else if (c === "?") {
      body += "[^/]";
    } else {
      body += escapeRegex(c);
    }
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  // Directory-only: the path must be strictly under it. Otherwise the pattern
  // matches the path itself or, when it names a directory, anything under it —
  // except that GitHub does not descend through a single-`*` last segment
  // (`docs/*` owns `docs/a.md`, not `docs/sub/b.md`).
  const last = p.slice(p.lastIndexOf("/") + 1);
  const noDescent = last.includes("*") && !last.includes("**");
  const suffix = dirOnly ? "/.+$" : noDescent ? "$" : "(?:/.+)?$";
  return new RegExp(prefix + body + suffix);
}

export function parseCodeowners(text: string): ParsedCodeowners {
  const rules: CodeownersRule[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((raw, idx) => {
    const line = idx + 1;
    const stripped = raw.replace(/\s+#.*$/, "").trim();
    if (stripped === "" || stripped.startsWith("#")) return;
    const [pattern, ...owners] = stripped.split(/\s+/);
    if (pattern === undefined) return;
    if (pattern.startsWith("!")) {
      errors.push(`line ${line}: \`${pattern}\` — negation is not supported by CODEOWNERS`);
      return;
    }
    if (/[[\]\\]/.test(pattern)) {
      errors.push(`line ${line}: \`${pattern}\` — character ranges / escapes are not supported`);
      return;
    }
    rules.push({ line, pattern, owners, regex: patternToRegex(pattern) });
  });
  return { rules, errors };
}

/** The rule that decides `path` (last match wins), or null when none matches. */
export function decidingRule(
  rules: readonly CodeownersRule[],
  path: string,
): CodeownersRule | null {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (rules[i]!.regex.test(path)) return rules[i]!;
  }
  return null;
}

/** Owners of `path` under GitHub semantics — empty when unmatched or unowned. */
export function ownersOf(rules: readonly CodeownersRule[], path: string): string[] {
  return decidingRule(rules, path)?.owners ?? [];
}

/**
 * A rule that would make every path in the repo owned — the line that turns a
 * code-owner-review ruleset into "every PR needs the owner".
 */
export function isCatchAll(rule: CodeownersRule): boolean {
  return ["README.md", "x", ".github/CODEOWNERS", "a/b/c.ts", "packages/p/src/deep/f.ts"].every(
    (p) => rule.regex.test(p),
  );
}
