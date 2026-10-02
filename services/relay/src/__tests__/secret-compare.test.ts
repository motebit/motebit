/**
 * Shared secrets and bearer tokens are compared in constant time.
 *
 * `secretEquals` is the relay's one comparator for operator secrets
 * (`x-relay-secret`, the master `apiToken`). The source guard below fails if a
 * plain `===` / `!==` against one of those secrets comes back anywhere in
 * `services/relay/src` — string equality short-circuits on the first differing
 * byte and leaks, via timing, how much of a guess is right.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { secretEquals } from "../secret-compare.js";

describe("secretEquals", () => {
  it("matches only the identical secret", () => {
    expect(secretEquals("s3cret", "s3cret")).toBe(true);
    expect(secretEquals("s3creT", "s3cret")).toBe(false);
    expect(secretEquals("s3cre", "s3cret")).toBe(false);
    expect(secretEquals("s3cret-longer", "s3cret")).toBe(false);
    expect(secretEquals("Bearer tok", "Bearer tok")).toBe(true);
  });

  it("fails closed when the expected secret is unset or empty", () => {
    expect(secretEquals("", "")).toBe(false);
    expect(secretEquals("", undefined)).toBe(false);
    expect(secretEquals("x", null)).toBe(false);
    expect(secretEquals(undefined, undefined)).toBe(false);
  });

  it("refuses a missing presentation", () => {
    expect(secretEquals(undefined, "s")).toBe(false);
    expect(secretEquals(null, "s")).toBe(false);
    expect(secretEquals("", "s")).toBe(false);
  });

  it("handles non-ASCII without throwing (digests are fixed-length)", () => {
    expect(secretEquals("pässwörd", "pässwörd")).toBe(true);
    expect(secretEquals("pässwörd", "passwort")).toBe(false);
  });
});

describe("source guard — no plain equality against an operator secret", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  // A secret identifier on either side of === / !==, or a template-built bearer
  // header compared directly.
  const FORBIDDEN = [
    /[!=]==\s*(?:deps\.)?apiToken\b/,
    /\b(?:deps\.)?apiToken\s*[!=]==\s*(?![\s"]|null\b|undefined\b)/,
    /[!=]==\s*`Bearer \$\{/,
    /[!=]==\s*expectedSecret\b/,
    /\bexpectedSecret\s*[!=]==/,
  ];

  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" ? [] : files(p);
      return e.name.endsWith(".ts") ? [p] : [];
    });
  }

  it("services/relay/src compares secrets only through secretEquals", () => {
    const scanned = files(SRC);
    expect(scanned.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const f of scanned) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
