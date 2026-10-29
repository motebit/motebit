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
import { checkDoctrineLayer, LAW_PROOFS_FILE } from "../check-doctrine-layer.ts";

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
  /*
  { name: "check-blocked", defends: "x", script: "check-blocked" },
  */
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
    "check-blocked": "npx tsx scripts/check-blocked.ts",
    "check-deploy-freshness": "npx tsx scripts/check-deploy-freshness.ts",
    "check-model-catalog-drift": "npx tsx scripts/check-model-catalog-drift.ts",
  },
});

const LAW_LINE =
  "> **Layer:** law (alpha; beta) — enforced by `check-real`, `check-renamed`, `check-ext`, `packages/pkg/src/__tests__/x.test.ts`, `packages/pkg/src/code.ts`";

const EDITS_Z = 'edits: [{ file: "scripts/check-real.ts", from: "export {};", to: "" }]';

/** The fixture's recorded law proofs: one per law doc, each naming an item its line names. */
const PROOFS = `export const PROOFS = [
  {
    doc: "law",
    claim: "alpha",
    named: "packages/pkg/src/__tests__/x.test.ts",
    name: "x", red: "suite case one", edits: [{ file: "packages/pkg/src/code.ts", from: "export {};", to: "" }],
  },
  {
    doc: "law",
    claim: "beta",
    named: "check-renamed",
    name: "y", edits: [{ file: "scripts/renamed-gate.ts", from: "export {};", to: "" }],
    command: ["npx", "tsx", "scripts/renamed-gate.ts"],
  },
  {
    // a chain doc keys by its filename
    doc: "CHAIN.md",
    claim: "body",
    named: "check-real",
    name: "z", edits: [{ file: "scripts/check-real.ts", from: "export {};", to: "" }],
    command: ["npx", "tsx", "scripts/check-real.ts"],
  },
];
`;

let root: string;

function put(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function doc(title: string, layerLine: string | null, body = "Body text."): string {
  return layerLine === null ? `# ${title}\n\n${body}\n` : `# ${title}\n\n${layerLine}\n\n${body}\n`;
}

/** Every problem reported, each prefixed with its site. */
async function allProblems(): Promise<string[]> {
  return (await checkDoctrineLayer(root)).findings.map((f) => `${f.site} — ${f.problem}`);
}

/** Problems about the layer line itself — the proof-record findings a broken line also causes are left to the proof cases. */
async function problems(): Promise<string[]> {
  return (await allProblems()).filter(
    (p) => !p.includes("tamper proof") && !p.startsWith(LAW_PROOFS_FILE),
  );
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
    "check-blocked",
    "check-deploy-freshness",
    "check-model-catalog-drift",
  ]) {
    put(`scripts/${f}.ts`, "export {};\n");
  }
  put(
    "packages/pkg/src/__tests__/x.test.ts",
    'describe("suite", () => {\n  it("case one", () => {});\n});\n',
  );
  put("packages/pkg/src/__tests__/fixtures/data.json", "{}\n");
  put("packages/pkg/src/__tests__/helpers.ts", "export {};\n");
  mkdirSync(join(root, "packages/pkg/src/__tests__/dir.test.ts"), { recursive: true });
  put(LAW_PROOFS_FILE, PROOFS);
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
  it("a tree where every doc declares a valid layer passes and counts law and narrative", async () => {
    const r = await checkDoctrineLayer(root);
    expect(r.findings).toEqual([]);
    expect(r.docs).toEqual(["docs/doctrine/law.md", "docs/doctrine/story.md", "CHAIN.md"]);
    expect(r.law).toBe(2);
    expect(r.narrative).toBe(1);
    expect(r.proofs).toBe(3);
    expect(r.claims).toBe(3);
    // 6 hard registrations, 2 of them scheduled external probes counted apart.
    expect(r.scheduledProbes).toBe(2);
    expect(r.registeredGates).toBe(4);
  });

  it("the real repo passes", async () => {
    const r = await checkDoctrineLayer(REPO_ROOT);
    expect(r.findings).toEqual([]);
    expect(r.law + r.narrative).toBe(r.docs.length);
  });
});

describe("check-doctrine-layer failure cases", () => {
  it("a doc with no layer line fails", async () => {
    put("docs/doctrine/story.md", doc("Story doc", null));
    expect(await problems()).toEqual([
      "docs/doctrine/story.md:3 — the first non-blank line after the H1 is not a `> **Layer:**` line",
    ]);
  });

  it("a layer line that is not the first non-blank line after the H1 fails", async () => {
    put("docs/doctrine/story.md", "# Story doc\n\nIntro first.\n\n> **Layer:** narrative\n");
    expect(await problems()).toEqual([
      "docs/doctrine/story.md:3 — the first non-blank line after the H1 is not a `> **Layer:**` line",
    ]);
  });

  it("a doc with two layer lines fails", async () => {
    put(
      "docs/doctrine/story.md",
      doc("Story doc", "> **Layer:** narrative", "Text.\n\n> **Layer:** narrative"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/story.md:7 — 2 layer lines; exactly one is allowed",
    ]);
  });

  it("a doc with no H1 fails", async () => {
    put("docs/doctrine/story.md", "> **Layer:** narrative\n\nNo title.\n");
    expect(await problems()).toEqual([
      "docs/doctrine/story.md — no H1 found, so there is nowhere to anchor the layer line",
    ]);
  });

  it("a malformed layer line fails", async () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law enforced by `check-real`"));
    expect(await problems()).toHaveLength(1);
    expect((await problems())[0]).toMatch(/^docs\/doctrine\/law\.md:3 — malformed layer line/);
  });

  it("an enforcement entry that is not backticked fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by check-real"),
    );
    expect(await problems()).toEqual([
      'docs/doctrine/law.md:3 — enforcement entry "check-real" is not a single backticked token',
    ]);
  });

  it("a law line naming an unregistered gate fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `check-unregistered`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — gate `check-unregistered` is not registered in scripts/check.ts (neither GATES nor EXCLUDED_CHECKS)",
    ]);
  });

  it("a law line naming a soft or advisory gate fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `check-soft`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — gate `check-soft` is registered as soft/advisory in EXCLUDED_CHECKS, so it enforces nothing",
    ]);
  });

  it("a law line naming a registered gate with no runnable source fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `check-nosource`"),
    );
    expect(await problems()).toHaveLength(1);
    expect((await problems())[0]).toMatch(
      /^docs\/doctrine\/law\.md:3 — gate `check-nosource` has no runnable source/,
    );
  });

  it("a law line naming a missing test file fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law (alpha) — enforced by `packages/pkg/src/__tests__/gone.test.ts`",
      ),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — named test file `packages/pkg/src/__tests__/gone.test.ts` does not exist",
    ]);
  });

  it("a law line naming a missing source file fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `packages/pkg/src/gone.ts`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — named source file `packages/pkg/src/gone.ts` does not exist",
    ]);
  });

  it("a chain doc without a layer line fails", async () => {
    put("CHAIN.md", doc("Chain", null, "---\n\nChain body."));
    expect(await problems()).toEqual([
      "CHAIN.md:3 — the first non-blank line after the H1 is not a `> **Layer:**` line",
    ]);
  });

  it("a chain doc DOCTRINE.md lists that does not exist fails", async () => {
    put(
      "DOCTRINE.md",
      "# Doctrine\n\n1. **[CHAIN.md](CHAIN.md)** — derives the thing.\n2. **[GONE.md](GONE.md)** — derives more.\n",
    );
    expect(await problems()).toEqual(["GONE.md — listed in scope but the file does not exist"]);
  });
  it("a law line naming a path that is neither a test nor a source file fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `README.md`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — `README.md` is neither a test file (`*.test.*` / `*.spec.*`) nor a source file under a package, app or service `src/` (a non-test file under `__tests__/` is neither)",
    ]);
  });

  it("a law line naming the repo root directory fails", async () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law (alpha) — enforced by `.`"));
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — `.` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a law line naming a directory shaped like a test file fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law (alpha) — enforced by `packages/pkg/src/__tests__/dir.test.ts`",
      ),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — named test file `packages/pkg/src/__tests__/dir.test.ts` is not a regular file",
    ]);
  });

  it("a law line naming a gate by its source path fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law (alpha) — enforced by `scripts/check-sibling-boundaries.ts`",
      ),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — `scripts/check-sibling-boundaries.ts` is a gate's source path — name the gate by its gate name (`check-sibling-boundaries`) so its registration is checked",
    ]);
  });

  it("a script entry outside the GATES array literal does not register", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `check-after`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — gate `check-after` is not registered in scripts/check.ts (neither GATES nor EXCLUDED_CHECKS)",
    ]);
  });

  it("a commented-out GATES entry does not register", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `check-commented`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — gate `check-commented` is not registered in scripts/check.ts (neither GATES nor EXCLUDED_CHECKS)",
    ]);
  });

  it("a gate whose EXCLUDED_CHECKS reason says warn-only, non-blocking or informational is refused", async () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law (alpha) — enforced by `check-warn`, `check-nonblocking`, `check-info`",
      ),
    );
    expect(await problems()).toEqual(
      ["check-warn", "check-nonblocking", "check-info"].map(
        (g) =>
          `docs/doctrine/law.md:3 — gate \`${g}\` is registered as soft/advisory in EXCLUDED_CHECKS, so it enforces nothing`,
      ),
    );
  });
  it("a path token with a `..` segment fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law (alpha) — enforced by `packages/pkg/src/__tests__/../../../../README.md`",
      ),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — `packages/pkg/src/__tests__/../../../../README.md` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a path token with a leading `./` fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `./packages/pkg/src/code.ts`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — `./packages/pkg/src/code.ts` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a path token with an inner `.` segment fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `packages/pkg/src/./code.ts`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — `packages/pkg/src/./code.ts` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a path token with an empty segment fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `packages/pkg//src/code.ts`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — `packages/pkg//src/code.ts` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("an absolute path token fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `/packages/pkg/src/code.ts`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — `/packages/pkg/src/code.ts` is not a normal repo-relative path — no leading `/`, no `.` / `..` / empty segment, and unchanged by path normalization",
    ]);
  });

  it("a law line naming a scheduled external probe fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law (alpha) — enforced by `check-deploy-freshness`, `check-model-catalog-drift`",
      ),
    );
    expect(await problems()).toEqual(
      ["check-deploy-freshness", "check-model-catalog-drift"].map(
        (g) =>
          `docs/doctrine/law.md:3 — gate \`${g}\` is a scheduled external probe — it runs on a schedule, never on a merge, so a broken claim can merge green; it enforces nothing at merge time`,
      ),
    );
  });
  it("a non-test file under __tests__ fails", async () => {
    put(
      "docs/doctrine/law.md",
      doc(
        "Law doc",
        "> **Layer:** law (alpha) — enforced by `packages/pkg/src/__tests__/helpers.ts`",
      ),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — `packages/pkg/src/__tests__/helpers.ts` is neither a test file (`*.test.*` / `*.spec.*`) nor a source file under a package, app or service `src/` (a non-test file under `__tests__/` is neither)",
    ]);
  });

  it("a GATES entry inside a block comment does not register", async () => {
    put(
      "docs/doctrine/law.md",
      doc("Law doc", "> **Layer:** law (alpha) — enforced by `check-blocked`"),
    );
    expect(await problems()).toEqual([
      "docs/doctrine/law.md:3 — gate `check-blocked` is not registered in scripts/check.ts (neither GATES nor EXCLUDED_CHECKS)",
    ]);
  });
});

describe("check-doctrine-layer law proofs", () => {
  const NO_PROOF = (doc: string, claim: string) =>
    `${doc} — claim "${claim}" has no recorded tamper proof — add a PROOFS entry in scripts/tampers/doctrine-law-labels.ts with doc "${doc}", claim "${claim}" and a named item from its law line, or drop the claim from the scope`;

  it("a bare law line with no scope fails", async () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law — enforced by `check-real`"));
    expect((await problems())[0]).toMatch(
      /^docs\/doctrine\/law\.md:3 — malformed layer line .*the scope is mandatory/,
    );
  });

  it("a scoped claim with no recorded tamper proof fails", async () => {
    put(LAW_PROOFS_FILE, PROOFS.replace('claim: "beta"', 'claim: "gamma"'));
    expect(await allProblems()).toContain(NO_PROOF("law", "beta"));
  });

  it("a chain doc's claim needs its own proof", async () => {
    put(LAW_PROOFS_FILE, PROOFS.replace('doc: "CHAIN.md"', 'doc: "OTHER.md"'));
    expect(await allProblems()).toContain(NO_PROOF("CHAIN.md", "body"));
  });

  it("a proof whose claim is not in the scope fails", async () => {
    put(LAW_PROOFS_FILE, PROOFS.replace('claim: "beta"', 'claim: "gamma"'));
    expect(await allProblems()).toContain(
      'scripts/tampers/doctrine-law-labels.ts — proof for "law" claims "gamma", which its law line\'s scope does not list',
    );
  });

  it("a proof naming an item the law line does not name fails", async () => {
    put(
      LAW_PROOFS_FILE,
      PROOFS.replace(
        "packages/pkg/src/__tests__/x.test.ts",
        "packages/pkg/src/__tests__/other.test.ts",
      ),
    );
    expect(await allProblems()).toContain(
      'scripts/tampers/doctrine-law-labels.ts — proof for "law" names `packages/pkg/src/__tests__/other.test.ts`, which its law line does not name',
    );
  });

  it("a proof for a doc that is not a law doc fails", async () => {
    put(
      LAW_PROOFS_FILE,
      PROOFS.replace('doc: "law",\n    claim: "alpha"', 'doc: "story",\n    claim: "alpha"'),
    );
    expect(await allProblems()).toContain(
      'scripts/tampers/doctrine-law-labels.ts — proof for "story" points at a doc that is not a law doc',
    );
  });

  it("a proof whose command does not run the gate it names fails", async () => {
    put(
      LAW_PROOFS_FILE,
      PROOFS.replace('"tsx", "scripts/renamed-gate.ts"', '"tsx", "scripts/check-ext.ts"'),
    );
    expect(await allProblems()).toContain(
      'scripts/tampers/doctrine-law-labels.ts — proof for "law" its command ["npx","tsx","scripts/check-ext.ts"] does not run the gate it names (`check-renamed` runs as ["npx","tsx","scripts/renamed-gate.ts"])',
    );
  });

  it("a vitest-mode proof that names a gate fails", async () => {
    put(
      LAW_PROOFS_FILE,
      PROOFS.replace('    command: ["npx", "tsx", "scripts/check-real.ts"],\n', ""),
    );
    expect(await allProblems()).toContain(
      'scripts/tampers/doctrine-law-labels.ts — proof for "CHAIN.md" it runs vitest but names `check-real`, which is not a test file — a gate is proven in command mode',
    );
  });

  it("a commented-out proof counts for nothing (comment decoy)", async () => {
    const decoy = PROOFS.replace(
      `  {
    doc: "law",
    claim: "beta",`,
      `  // {
  //   doc: "law",
  //   claim: "beta",`,
    ).replace(
      `    named: "check-renamed",
    name: "y", edits: [{ file: "scripts/renamed-gate.ts", from: "export {};", to: "" }],
    command: ["npx", "tsx", "scripts/renamed-gate.ts"],
  },`,
      `  //   named: "check-renamed",
  //  name: "y", edits: [{ file: "scripts/renamed-gate.ts", from: "export {};", to: "" }],
  //   command: ["npx", "tsx", "scripts/renamed-gate.ts"],
  // },`,
    );
    put(LAW_PROOFS_FILE, decoy);
    expect(await allProblems()).toContain(NO_PROOF("law", "beta"));
  });

  it("a proof-shaped object outside PROOFS counts for nothing (dead-code decoy)", async () => {
    const live = PROOFS.replace(
      `  {
    doc: "law",
    claim: "beta",
    named: "check-renamed",
    name: "y", edits: [{ file: "scripts/renamed-gate.ts", from: "export {};", to: "" }],
    command: ["npx", "tsx", "scripts/renamed-gate.ts"],
  },
`,
      "",
    );
    put(
      LAW_PROOFS_FILE,
      live +
        `
const UNUSED = [
  {
    doc: "law",
    claim: "beta",
    named: "check-renamed",
    name: "y", edits: [{ file: "scripts/renamed-gate.ts", from: "export {};", to: "" }],
    command: ["npx", "tsx", "scripts/renamed-gate.ts"],
  },
];
void UNUSED;
`,
    );
    expect(await allProblems()).toContain(NO_PROOF("law", "beta"));
  });
  it("a proof with no edits fails", async () => {
    put(LAW_PROOFS_FILE, PROOFS.replace(EDITS_Z, "edits: []"));
    expect(await allProblems()).toContain(
      'scripts/tampers/doctrine-law-labels.ts — proof for "CHAIN.md" has no edits — a proof must break something',
    );
  });

  it("a proof edit that does not occur in its file fails", async () => {
    put(
      LAW_PROOFS_FILE,
      PROOFS.replace(EDITS_Z, EDITS_Z.replace('from: "export {};"', 'from: "export {}; // gone"')),
    );
    expect(await allProblems()).toContain(
      'scripts/tampers/doctrine-law-labels.ts — proof for "CHAIN.md" edit "export {}; // gone" occurs 0 time(s) in scripts/check-real.ts — a tamper edit must match exactly once',
    );
  });

  it("a proof edit that occurs more than once fails", async () => {
    put("scripts/check-real.ts", "export {};\nexport {};\n");
    expect(await allProblems()).toContain(
      'scripts/tampers/doctrine-law-labels.ts — proof for "CHAIN.md" edit "export {};" occurs 2 time(s) in scripts/check-real.ts — a tamper edit must match exactly once',
    );
  });

  it("a vitest proof whose red test the named file does not declare fails", async () => {
    put(LAW_PROOFS_FILE, PROOFS.replace('red: "suite case one"', 'red: "suite case two"'));
    expect(await allProblems()).toContain(
      'scripts/tampers/doctrine-law-labels.ts — proof for "law" its red test "suite case two" is not a test declared in packages/pkg/src/__tests__/x.test.ts',
    );
  });
});
