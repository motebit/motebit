/**
 * The repository path policy interpreter (`motebit/repo-path-policy@1.0`,
 * spec/repo-change-v1.md §7.2): strict parse (every malformed shape refused),
 * the closed pattern grammar, and the matching semantics both judges rely on —
 * includes name files (no descent, exact case), excludes descend and fold
 * ASCII case. The differential test against the classifier's former regex
 * predicate lives in scripts/__tests__/classify-autonomy-tier.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import * as verifier from "../index.js";
import {
  REPO_PATH_POLICY_FILE,
  REPO_PATH_POLICY_SPEC,
  isRepoPathIncluded,
  isRepoPathPermitted,
  parseRepoPathPolicy,
  repoPathExclusion,
  type RepoPathPolicy,
} from "../repo-path-policy.js";

const SPEC = REPO_PATH_POLICY_SPEC;
const doc = (o: unknown): string => JSON.stringify(o);
const policy = (include: string[], exclude: string[] = []): RepoPathPolicy =>
  parseRepoPathPolicy(doc({ spec: SPEC, include, exclude }));

describe("parseRepoPathPolicy strict shape", () => {
  it("parses the minimal well-formed policy", () => {
    expect(parseRepoPathPolicy(doc({ spec: SPEC, include: [], exclude: [] }))).toEqual({
      spec: SPEC,
      include: [],
      exclude: [],
    });
  });

  it("the parsed policy is frozen (a caller cannot widen it after parsing)", () => {
    const p = policy(["docs/*.md"]);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.include)).toBe(true);
    expect(Object.isFrozen(p.exclude)).toBe(true);
  });

  const MALFORMED: Array<[string, string]> = [
    ["not JSON", "{"],
    ["empty text", ""],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["a JSON string", '"motebit/repo-path-policy@1.0"'],
    ["a missing spec", doc({ include: [], exclude: [] })],
    ["a missing include", doc({ spec: SPEC, exclude: [] })],
    ["a missing exclude", doc({ spec: SPEC, include: [] })],
    ["an unknown key", doc({ spec: SPEC, include: [], exclude: [], extra: true })],
    ["an unknown key (__proto__)", `{"spec":"${SPEC}","include":[],"exclude":[],"__proto__":{}}`],
    [
      "another spec version",
      doc({ spec: "motebit/repo-path-policy@1.1", include: [], exclude: [] }),
    ],
    ["a spec that is not a string", doc({ spec: 1, include: [], exclude: [] })],
    ["include not an array", doc({ spec: SPEC, include: "docs/*.md", exclude: [] })],
    ["exclude not an array", doc({ spec: SPEC, include: [], exclude: {} })],
    ["a non-string include pattern", doc({ spec: SPEC, include: [1], exclude: [] })],
    ["a null exclude pattern", doc({ spec: SPEC, include: [], exclude: [null] })],
    ["a nested array pattern", doc({ spec: SPEC, include: [["docs/*.md"]], exclude: [] })],
    ["a duplicate include", doc({ spec: SPEC, include: ["docs/*.md", "docs/*.md"], exclude: [] })],
    ["a duplicate exclude", doc({ spec: SPEC, include: [], exclude: ["a/**", "a/**"] })],
  ];
  for (const [name, text] of MALFORMED) {
    it(`refuses ${name}`, () => {
      expect(() => parseRepoPathPolicy(text)).toThrow(/repo path policy/);
    });
  }

  it("refuses a policy object built by hand with an unknown key when it is used", () => {
    const forged = {
      spec: SPEC,
      include: ["**"],
      exclude: [],
      extra: 1,
    } as unknown as RepoPathPolicy;
    expect(() => isRepoPathPermitted(forged, "a.md")).toThrow(/unknown key/);
  });

  it("refuses a policy object built by hand with an out-of-grammar pattern when it is used", () => {
    const forged = { spec: SPEC, include: ["docs/[a].md"], exclude: [] } as RepoPathPolicy;
    expect(() => isRepoPathPermitted(forged, "docs/a.md")).toThrow(/outside the grammar/);
  });

  it("refuses a member name repeated in one object (a later copy would replace the list a reviewer read)", () => {
    const head = `{"spec":"${SPEC}","include":["docs/*.md"],"exclude":["docs/secret.md"]`;
    expect(() => parseRepoPathPolicy(`${head},"exclude":[]}`)).toThrow(/"exclude" is repeated/);
    // The same name spelt with an escape is the same name.
    expect(() => parseRepoPathPolicy(`${head},"exclud\\u0065":[]}`)).toThrow(/is repeated/);
    expect(() => parseRepoPathPolicy(`${head},"include":["apps/**"]}`)).toThrow(/is repeated/);
  });

  it("a repeated string that is not a member name is not a repeated member", () => {
    // Strings equal to member names, inside the lists, are values; an escape inside a value is skipped whole.
    const p = parseRepoPathPolicy(
      `{"spec":"${SPEC}","include":["spec","exclude","docs\\/a.md"],"exclude":["include"]}`,
    );
    expect(p.include).toEqual(["spec", "exclude", "docs/a.md"]);
  });

  it("a policy object built by hand is judged as it is at each use, never from a stale compile", () => {
    const handBuilt = { spec: SPEC, include: ["docs/*.md", "apps/**"], exclude: [] as string[] };
    expect(isRepoPathPermitted(handBuilt, "apps/x.ts")).toBe(true);
    handBuilt.include.pop();
    expect(isRepoPathPermitted(handBuilt, "apps/x.ts")).toBe(false);
  });
});

describe("parseRepoPathPolicy closed grammar", () => {
  const ACCEPTED = [
    "docs/**/*.md",
    "tools/bench/*/prompts.json",
    "docs/doctrine/**",
    "**/CLAUDE.md",
    "**/.claude/**",
    "docs/drift-defenses.md",
    "README.md",
    "a/*b*c*/d",
    "a_b-c.d",
  ];
  for (const p of ACCEPTED) {
    it(`accepts ${JSON.stringify(p)}`, () => {
      expect(() => policy([p], [p])).not.toThrow();
    });
  }

  const REFUSED = [
    "",
    "/docs/a.md",
    "docs/",
    "docs//a.md",
    "**",
    "**/**/a.md",
    "docs/**/**",
    "docs/a**.md",
    "docs/**.md",
    "docs/***",
    "docs/?.md",
    "docs/[ab].md",
    "docs/{a,b}.md",
    "!docs/a.md",
    "docs\\a.md",
    "docs/a b.md",
    "docs/./a.md",
    "docs/../a.md",
    ".",
    "..",
    "docs/ſ.md",
    "docs/é.md",
    "docs/a.md\n",
    "docs/a#.md",
    "docs/a~",
  ];
  for (const p of REFUSED) {
    it(`refuses the include pattern ${JSON.stringify(p)}`, () => {
      expect(() => policy([p])).toThrow(/repo path policy/);
    });
    it(`refuses the exclude pattern ${JSON.stringify(p)}`, () => {
      expect(() => policy([], [p])).toThrow(/repo path policy/);
    });
  }
});

describe("repo path policy matching", () => {
  it("an include names files: it never covers a directory of that name", () => {
    const p = policy(["tools/bench/*/prompts.json", "docs/drift.md"]);
    expect(isRepoPathPermitted(p, "tools/bench/x/prompts.json")).toBe(true);
    expect(isRepoPathPermitted(p, "tools/bench/x/prompts.json/evil.ts")).toBe(false);
    expect(isRepoPathPermitted(p, "docs/drift.md")).toBe(true);
    expect(isRepoPathPermitted(p, "docs/drift.md/x")).toBe(false);
    expect(isRepoPathIncluded(p, "docs/drift.md/x")).toBe(false);
  });

  it("an include matches in its own case only", () => {
    const p = policy(["docs/**/*.md"]);
    expect(isRepoPathPermitted(p, "docs/a.md")).toBe(true);
    expect(isRepoPathPermitted(p, "Docs/a.md")).toBe(false);
    expect(isRepoPathPermitted(p, "docs/a.MD")).toBe(false);
  });

  it("`*` stays within one segment and may be empty", () => {
    const p = policy(["tools/bench/*/prompts.json", "a/*.md"]);
    expect(isRepoPathPermitted(p, "tools/bench/x/y/prompts.json")).toBe(false);
    expect(isRepoPathPermitted(p, "tools/bench//prompts.json")).toBe(true);
    expect(isRepoPathPermitted(p, "a/.md")).toBe(true);
    expect(isRepoPathPermitted(p, "a/b/c.md")).toBe(false);
  });

  it("a non-last `**` covers zero or more segments", () => {
    const p = policy(["docs/**/*.md", "**/x.json"]);
    expect(isRepoPathPermitted(p, "docs/a.md")).toBe(true);
    expect(isRepoPathPermitted(p, "docs/a/b/c.md")).toBe(true);
    expect(isRepoPathPermitted(p, "x.json")).toBe(true);
    expect(isRepoPathPermitted(p, "a/b/x.json")).toBe(true);
    expect(isRepoPathPermitted(p, "a.md")).toBe(false);
  });

  it("a last `**` covers one or more segments, never the directory itself", () => {
    const p = policy(["**/*.md"], ["docs/doctrine/**"]);
    expect(repoPathExclusion(p, "docs/doctrine/a.md")).toBe("exact");
    expect(repoPathExclusion(p, "docs/doctrine/a/b.md")).toBe("exact");
    expect(repoPathExclusion(p, "docs/doctrine")).toBeNull();
    expect(repoPathExclusion(p, "docs/doctrine.md")).toBeNull();
  });

  it("an exclude descends: it covers every path beneath a path it matches", () => {
    const p = policy(["**/*.md"], ["**/CLAUDE.md", "docs/drift-defenses.md"]);
    expect(repoPathExclusion(p, "docs/CLAUDE.md")).toBe("exact");
    expect(repoPathExclusion(p, "docs/CLAUDE.md/x.md")).toBe("exact");
    expect(repoPathExclusion(p, "docs/drift-defenses.md/a/b.md")).toBe("exact");
    expect(isRepoPathPermitted(p, "docs/drift-defenses.md/a/b.md")).toBe(false);
    // Descent needs at least one more character after the `/`.
    expect(repoPathExclusion(p, "docs/CLAUDE.md/")).toBeNull();
  });

  it("an exclude folds ASCII case, and says when only the folded form matched", () => {
    const p = policy(["docs/**/*.md"], ["**/CLAUDE.md", "docs/doctrine/**"]);
    expect(repoPathExclusion(p, "docs/claude.md")).toBe("case_folded");
    expect(repoPathExclusion(p, "docs/DOCTRINE/a.md")).toBe("case_folded");
    expect(repoPathExclusion(p, "docs/Doctrine/x/claude.md")).toBe("case_folded");
    expect(isRepoPathPermitted(p, "docs/claude.md")).toBe(false);
    expect(isRepoPathPermitted(p, "docs/DOCTRINE/a.md")).toBe(false);
  });

  it("case folding is ASCII only: non-ASCII look-alikes are not folded", () => {
    const p = policy(["docs/**/*.md"], ["**/SKILL.md", "**/kit.md"]);
    // ſ (U+017F) upper-cases to S, and K (U+212A, Kelvin) lower-cases to k: neither folds here.
    expect(repoPathExclusion(p, "docs/ſKILL.md")).toBeNull();
    expect(repoPathExclusion(p, "docs/\u212Ait.md")).toBeNull();
    expect(repoPathExclusion(p, "docs/SKİLL.md")).toBeNull();
  });

  it("a path with a line terminator is never permitted", () => {
    const p = policy(["docs/**/*.md"]);
    for (const t of ["\n", "\r", "\u2028", "\u2029"]) {
      expect(isRepoPathPermitted(p, `docs/a${t}b.md`), JSON.stringify(t)).toBe(false);
      expect(isRepoPathIncluded(p, `docs/a${t}b.md`), JSON.stringify(t)).toBe(true);
    }
    expect(isRepoPathPermitted(p, "docs/a\tb.md")).toBe(true);
  });

  it("an exclude wins over an include", () => {
    const p = policy(["docs/**/*.md"], ["docs/doctrine/**"]);
    expect(isRepoPathPermitted(p, "docs/a.md")).toBe(true);
    expect(isRepoPathPermitted(p, "docs/doctrine/a.md")).toBe(false);
  });

  it("patterns match from the root (no gitignore-style floating)", () => {
    const p = policy(["README.md"]);
    expect(isRepoPathPermitted(p, "README.md")).toBe(true);
    expect(isRepoPathPermitted(p, "docs/README.md")).toBe(false);
  });
});

describe("the repository's own policy file", () => {
  it(`${REPO_PATH_POLICY_FILE} parses strictly and is outside its own includes`, () => {
    const text = readFileSync(resolve(__dirname, "../../../..", REPO_PATH_POLICY_FILE), "utf-8");
    const p = parseRepoPathPolicy(text);
    expect(p.spec).toBe(SPEC);
    expect(isRepoPathPermitted(p, REPO_PATH_POLICY_FILE)).toBe(false);
  });

  it("the interpreter is exported from the package index", () => {
    expect(verifier.parseRepoPathPolicy).toBe(parseRepoPathPolicy);
    expect(verifier.isRepoPathPermitted).toBe(isRepoPathPermitted);
    expect(verifier.isRepoPathIncluded).toBe(isRepoPathIncluded);
    expect(verifier.repoPathExclusion).toBe(repoPathExclusion);
    expect(verifier.REPO_PATH_POLICY_SPEC).toBe(SPEC);
    expect(verifier.REPO_PATH_POLICY_FILE).toBe(".motebit/repo-path-policy.json");
  });

  it("the interpreter module imports nothing (the classifier loads it by source path, unbuilt)", () => {
    const src = readFileSync(resolve(__dirname, "../repo-path-policy.ts"), "utf-8");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\b/m);
  });
});
