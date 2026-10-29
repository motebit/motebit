/**
 * check-liquescent-ontology — no Layer 1 "the body is glass" claim anywhere,
 * except allowlisted lines, each anchored on its file plus its exact text and
 * required to match exactly one line.
 *
 * Drives `checkLiquescentOntology(root, allowlist)` over a fixture tree built
 * per test, with a one-entry allowlist, so each case plants one change
 * against an otherwise green tree. One case runs the gate over the real repo
 * with the real ALLOWLIST. Tamper entries: scripts/tampers/liquescent-ontology.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLiquescentOntology, type AllowlistEntry } from "../check-liquescent-ontology.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Built at runtime so this file never carries the forbidden phrase itself
// (the real-repo case scans scripts/__tests__ too).
const GD = ["glass", "droplet"].join(" ");

const ALLOWED = `A ${GD} in a uniform medium is invisible. Transmission at 0.94 means most light passes, so the droplet vanishes.`;
const ALLOW: AllowlistEntry[] = [{ file: "MEDIUM.md", text: ALLOWED }];
const MEDIUM = `# Medium\n\n## Optics\n\n${ALLOWED}\n\nThe body is liquescent.\n`;

let root: string;

function put(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function run() {
  return checkLiquescentOntology(root, ALLOW);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "liquescent-ontology-"));
  put("MEDIUM.md", MEDIUM);
  put("docs/other.md", "# Other\n\nThe motebit is a liquescent droplet.\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-liquescent-ontology", () => {
  it("a clean fixture tree passes", () => {
    const r = run();
    expect(r.findings).toEqual([]);
    expect(r.badEntries).toEqual([]);
    expect(r.scanned).toBe(2);
  });

  it("an allowlisted sentence moved down the file passes", () => {
    put(
      "MEDIUM.md",
      MEDIUM.replace("## Optics", "## Added heading\n\nA new paragraph.\n\n## Optics"),
    );
    const r = run();
    expect(r.findings).toEqual([]);
    expect(r.badEntries).toEqual([]);
  });

  it("an allowlisted sentence with a changed constant fails", () => {
    put("MEDIUM.md", MEDIUM.replace("Transmission at 0.94", "Transmission at 0.95"));
    const r = run();
    expect(r.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["MEDIUM.md:5"]);
    expect(r.badEntries.map((b) => b.count)).toEqual([0]);
  });

  it("an allowlisted sentence with a changed comma fails", () => {
    put("MEDIUM.md", MEDIUM.replace("passes, so", "passes so"));
    const r = run();
    expect(r.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["MEDIUM.md:5"]);
    expect(r.badEntries.map((b) => b.count)).toEqual([0]);
  });

  it("a removed allowlisted sentence is reported stale", () => {
    put("MEDIUM.md", MEDIUM.replace(`${ALLOWED}\n\n`, ""));
    const r = run();
    expect(r.findings).toEqual([]);
    expect(r.badEntries).toEqual([{ entry: ALLOW[0], count: 0 }]);
  });

  it("a verbatim copy of an allowlisted sentence fails with count 2", () => {
    put("MEDIUM.md", `${MEDIUM}\n${ALLOWED}\n`);
    const r = run();
    expect(r.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["MEDIUM.md:5", "MEDIUM.md:9"]);
    expect(r.badEntries).toEqual([{ entry: ALLOW[0], count: 2 }]);
  });

  it("a forbidden phrase in an ordinary file fails", () => {
    put("docs/other.md", `# Other\n\nThe creature is a ${GD}.\n`);
    const r = run();
    expect(r.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["docs/other.md:3"]);
    expect(r.badEntries).toEqual([]);
  });

  it("the allowlisted text copied into another file fails there", () => {
    put("docs/other.md", `# Other\n\n${ALLOWED}\n`);
    const r = run();
    expect(r.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["docs/other.md:3"]);
    expect(r.badEntries).toEqual([]);
  });

  it("a forbidden phrase inside a backtick citation passes", () => {
    put("docs/other.md", `# Other\n\nThe gate forbids \`${GD}\` as ontology.\n`);
    const r = run();
    expect(r.findings).toEqual([]);
  });

  it("the clean repo passes with the real allowlist", () => {
    const r = checkLiquescentOntology(REPO_ROOT);
    expect(r.findings).toEqual([]);
    expect(r.badEntries).toEqual([]);
    expect(r.scanned).toBeGreaterThan(1000);
  });
});
