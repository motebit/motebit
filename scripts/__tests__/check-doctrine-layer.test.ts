/**
 * check-doctrine-layer — every doctrine doc declares one layer line after its
 * H1, and every enforcement a law line names is real.
 *
 * Drives `checkDoctrineLayer(root)` over a small fixture tree built per test
 * (a stand-in `scripts/check.ts`, root `package.json`, `DOCTRINE.md`, chain
 * doc and doctrine docs), so each failure the gate exists to catch is planted
 * alone against a tree that is otherwise green. One case also runs the gate
 * over the real repo. Tamper entries: scripts/tampers/doctrine-layer.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDoctrineLayer } from "../check-doctrine-layer.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CHECK_TS = `
const EXCLUDED_CHECKS: Record<string, string> = {
  "check-soft": "soft signal (knip) — CI uses continue-on-error, not a hard gate",
  "check-ext": "meta-probe — runs as a separate CI job scoped to scripts/* changes.",
  "check-warn": "warn-only — prints findings, exits 0",
  "check-nonblocking": "non-blocking report, runs nightly",
  "check-info": "informational summary for reviewers",
  "check-deploy-freshness": "the second EXTERNAL drift gate — needs network + FLY_API_TOKEN. Runs daily from .github/workflows/deploy-freshness.yml.",
  "check-model-catalog-drift": "the EXTERNAL drift gate — needs ANTHROPIC_API_KEY. Runs weekly from .github/workflows/model-catalog-drift.yml.",
};

const GATES = [
  { name: "check-real", defends: "x", script: "check-real" },
  { name: "check-renamed", defends: "x", script: "check-renamed" },
  { name: "check-nosource", defends: "x", script: "check-nosource" },
  // { name: "check-commented", defends: "x", script: "check-commented" },
];

// A later literal that is not GATES.
const OTHER = [{ script: "check-after" }];
`;

const PACKAGE_JSON = JSON.stringify({
  scripts: {
    "check-real": "npx tsx scripts/check-real.ts",
    "check-renamed": "npx tsx scripts/renamed-gate.ts",
    "check-ext": "npx tsx scripts/check-ext.ts",
    "check-soft": "npx tsx scripts/check-soft.ts",
    "check-unregistered": "npx tsx scripts/check-unregistered.ts",
    "check-nosource": "npx tsx scripts/check-nosource.ts",
    "check-warn": "npx tsx scripts/check-warn.ts",
    "check-nonblocking": "npx tsx scripts/check-nonblocking.ts",
    "check-info": "npx tsx scripts/check-info.ts",
    "check-commented": "npx tsx scripts/check-commented.ts",
    "check-after": "npx tsx scripts/check-after.ts",
    "check-deploy-freshness": "npx tsx scripts/check-deploy-freshness.ts",
    "check-model-catalog-drift": "npx tsx scripts/check-model-catalog-drift.ts",
  },
});

const LAW_LINE =
  "> **Layer:** law — enforced by `check-real`, `check-renamed`, `check-ext`, `packages/pkg/src/__tests__/x.test.ts`, `packages/pkg/src/code.ts`";

let root: string;

function put(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function doc(title: string, layerLine: string | null, body = "Body text."): string {
  return layerLine === null ? `# ${title}\n\n${body}\n` : `# ${title}\n\n${layerLine}\n\n${body}\n`;
}

/** Problems reported, each prefixed with its site. */
function problems(): string[] {
  return checkDoctrineLayer(root).findings.map((f) => `${f.site} — ${f.problem}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doctrine-layer-"));
  put("scripts/check.ts", CHECK_TS);
  put("package.json", PACKAGE_JSON);
  for (const f of [
    "check-real",
    "renamed-gate",
    "check-ext",
    "check-soft",
    "check-unregistered",
    "check-warn",
    "check-nonblocking",
    "check-info",
    "check-commented",
    "check-after",
    "check-deploy-freshness",
    "check-model-catalog-drift",
  ]) {
    put(`scripts/${f}.ts`, "export {};\n");
  }
  put("packages/pkg/src/__tests__/x.test.ts", "export {};\n");
  put("packages/pkg/src/__tests__/fixtures/data.json", "{}\n");
  put("packages/pkg/src/code.ts", "export {};\n");
  put("README.md", "# Readme\n");
  put(
    "DOCTRINE.md",
    "# Doctrine\n\n## The chain\n\n1. **[CHAIN.md](CHAIN.md)** — derives the thing.\n",
  );
  put(
    "CHAIN.md",
    doc("Chain", "> **Layer:** law (body) — enforced by `check-real`", "---\n\nChain body."),
  );
  put("docs/doctrine/law.md", doc("Law doc", LAW_LINE));
  put("docs/doctrine/story.md", doc("Story doc", "> **Layer:** narrative"));
  put("docs/doctrine/audits/old.md", "# An audit with no layer line\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-doctrine-layer passing cases", () => {
  it("a tree where every doc declares a valid layer passes and counts law and narrative", () => {
    const r = checkDoctrineLayer(root);
    expect(r.findings).toEqual([]);
    expect(r.docs).toEqual(["docs/doctrine/law.md", "docs/doctrine/story.md", "CHAIN.md"]);
    expect(r.law).toBe(2);
    expect(r.narrative).toBe(1);
  });

  it("the real repo passes", () => {
    const r = checkDoctrineLayer(REPO_ROOT);
    expect(r.findings).toEqual([]);
    expect(r.law + r.narrative).toBe(r.docs.length);
  });
});

describe("check-doctrine-layer failure cases", () => {
  it("a doc with no layer line fails", () => {
    put("docs/doctrine/story.md", doc("Story doc", null));
    expect(problems()).toEqual([
      "docs/doctrine/story.md:3 — the first non-blank line after the H1 is not a `> **Layer:**` line",
    ]);
  });

  it("a layer line that is not the first non-blank line after the H1 fails", () => {
    put("docs/doctrine/story.md", "# Story doc\n\nIntro first.\n\n> **Layer:** narrative\n");
    expect(problems()).toEqual([
      "docs/doctrine/story.md:3 — the first non-blank line after the H1 is not a `> **Layer:**` line",
    ]);
  });

  it("a doc with two layer lines fails", () => {
    put(
      "docs/doctrine/story.md",
      doc("Story doc", "> **Layer:** narrative", "Text.\n\n> **Layer:** narrative"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/story.md:7 — 2 layer lines; exactly one is allowed",
    ]);
  });

  it("a doc with no H1 fails", () => {
    put("docs/doctrine/story.md", "> **Layer:** narrative\n\nNo title.\n");
    expect(problems()).toEqual([
      "docs/doctrine/story.md — no H1 found, so there is nowhere to anchor the layer line",
    ]);
  });

  it("a malformed layer line fails", () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law enforced by `check-real`"));
    expect(problems()).toHaveLength(1);
    expect(problems()[0]).toMatch(/^docs\/doctrine\/law\.md:3 — malformed layer line/);
  });

  it("an enforcement entry that is not backticked fails", () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law — enforced by check-real"));
    expect(problems()).toEqual([
      'docs/doctrine/law.md:3 — enforcement entry "check-real" is not a single backticked token',
    ]);
  });

  it("a law line naming an unregistered gate fails", () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law — enforced by `check-unregistered`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — gate `check-unregistered` is not registered in scripts/check.ts (neither GATES nor EXCLUDED_CHECKS)",
    ]);
  });

  it("a law line naming a soft or advisory gate fails", () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law — enforced by `check-soft`"));
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — gate `check-soft` is registered as soft/advisory in EXCLUDED_CHECKS, so it enforces nothing",
    ]);
  });

  it("a law line naming a registered gate with no runnable source fails", () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law — enforced by `check-nosource`"));
    expect(problems()).toHaveLength(1);
    expect(problems()[0]).toMatch(
      /^docs\/doctrine\/law\.md:3 — gate `check-nosource` has no runnable source/,
    );
  });

  it("a law line naming a missing test file fails", () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law — enforced by `packages/pkg/src/__tests__/gone.test.ts`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — named test file `packages/pkg/src/__tests__/gone.test.ts` does not exist",
    ]);
  });

  it("a law line naming a missing source file fails", () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law — enforced by `packages/pkg/src/gone.ts`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — named source file `packages/pkg/src/gone.ts` does not exist",
    ]);
  });

  it("a chain doc without a layer line fails", () => {
    put("CHAIN.md", doc("Chain", null, "---\n\nChain body."));
    expect(problems()).toEqual([
      "CHAIN.md:3 — the first non-blank line after the H1 is not a `> **Layer:**` line",
    ]);
  });

  it("a chain doc DOCTRINE.md lists that does not exist fails", () => {
    put(
      "DOCTRINE.md",
      "# Doctrine\n\n1. **[CHAIN.md](CHAIN.md)** — derives the thing.\n2. **[GONE.md](GONE.md)** — derives more.\n",
    );
    expect(problems()).toEqual(["GONE.md — listed in scope but the file does not exist"]);
  });
  it("a law line naming a path that is neither a test nor a source file fails", () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law — enforced by `README.md`"));
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — `README.md` is neither a test file (`*.test.ts` / `*.spec.ts` or under `__tests__/`) nor a source file under a package, app or service `src/`",
    ]);
  });

  it("a law line naming the repo root directory fails", () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law — enforced by `.`"));
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — `.` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a law line naming a directory under __tests__ fails", () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law — enforced by `packages/pkg/src/__tests__/fixtures`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — named test file `packages/pkg/src/__tests__/fixtures` is not a regular file",
    ]);
  });

  it("a law line naming a gate by its source path fails", () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law — enforced by `scripts/check-sibling-boundaries.ts`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — `scripts/check-sibling-boundaries.ts` is a gate's source path — name the gate by its gate name (`check-sibling-boundaries`) so its registration is checked",
    ]);
  });

  it("a script entry outside the GATES array literal does not register", () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law — enforced by `check-after`"));
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — gate `check-after` is not registered in scripts/check.ts (neither GATES nor EXCLUDED_CHECKS)",
    ]);
  });

  it("a commented-out GATES entry does not register", () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law — enforced by `check-commented`"));
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — gate `check-commented` is not registered in scripts/check.ts (neither GATES nor EXCLUDED_CHECKS)",
    ]);
  });

  it("a gate whose EXCLUDED_CHECKS reason says warn-only, non-blocking or informational is refused", () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law — enforced by `check-warn`, `check-nonblocking`, `check-info`",
      ),
    );
    expect(problems()).toEqual(
      ["check-warn", "check-nonblocking", "check-info"].map(
        (g) =>
          `docs/doctrine/law.md:3 — gate \`${g}\` is registered as soft/advisory in EXCLUDED_CHECKS, so it enforces nothing`,
      ),
    );
  });
  it("a path token with a `..` segment fails", () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law — enforced by `packages/pkg/src/__tests__/../../../../README.md`",
      ),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — `packages/pkg/src/__tests__/../../../../README.md` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a path token with a leading `./` fails", () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law — enforced by `./packages/pkg/src/code.ts`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — `./packages/pkg/src/code.ts` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a path token with an inner `.` segment fails", () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law — enforced by `packages/pkg/src/./code.ts`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — `packages/pkg/src/./code.ts` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a path token with an empty segment fails", () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law — enforced by `packages/pkg//src/code.ts`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — `packages/pkg//src/code.ts` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("an absolute path token fails", () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law — enforced by `/packages/pkg/src/code.ts`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — `/packages/pkg/src/code.ts` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a law line naming a scheduled external probe fails", () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law — enforced by `check-deploy-freshness`, `check-model-catalog-drift`",
      ),
    );
    expect(problems()).toEqual(
      ["check-deploy-freshness", "check-model-catalog-drift"].map(
        (g) =>
          `docs/doctrine/law.md:3 — gate \`${g}\` is a scheduled external probe — it runs on a schedule, never on a merge, so a broken claim can merge green; it enforces nothing at merge time`,
      ),
    );
  });
});
