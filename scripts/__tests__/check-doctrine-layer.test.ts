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
};

const GATES = [
  { name: "check-real", defends: "x", script: "check-real" },
  { name: "check-renamed", defends: "x", script: "check-renamed" },
  { name: "check-nosource", defends: "x", script: "check-nosource" },
];
`;

const PACKAGE_JSON = JSON.stringify({
  scripts: {
    "check-real": "npx tsx scripts/check-real.ts",
    "check-renamed": "npx tsx scripts/renamed-gate.ts",
    "check-ext": "npx tsx scripts/check-ext.ts",
    "check-soft": "npx tsx scripts/check-soft.ts",
    "check-unregistered": "npx tsx scripts/check-unregistered.ts",
    "check-nosource": "npx tsx scripts/check-nosource.ts",
  },
});

const LAW_LINE =
  "> **Layer:** law — enforced by `check-real`, `check-renamed`, `check-ext`, `pkg/src/__tests__/x.test.ts`, `pkg/src/code.ts`";

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
  for (const f of ["check-real", "renamed-gate", "check-ext", "check-soft", "check-unregistered"]) {
    put(`scripts/${f}.ts`, "export {};\n");
  }
  put("pkg/src/__tests__/x.test.ts", "export {};\n");
  put("pkg/src/code.ts", "export {};\n");
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
      doc("Law doc", "> **Layer:** law — enforced by `pkg/src/__tests__/gone.test.ts`"),
    );
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — named test file `pkg/src/__tests__/gone.test.ts` does not exist",
    ]);
  });

  it("a law line naming a missing code path fails", () => {
    put("docs/doctrine/law.md", doc("Law doc", "> **Layer:** law — enforced by `pkg/src/gone.ts`"));
    expect(problems()).toEqual([
      "docs/doctrine/law.md:3 — named code path `pkg/src/gone.ts` does not exist",
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
});
