/**
 * workflow-triggers — the one reader of `on.push` (#731).
 *
 * Two external gates hand-rolled this and had already diverged. The cases
 * below are the shapes this repo's workflows actually use plus the mutations
 * each gate cares about: a paths filter appearing, `main` leaving `branches`,
 * the list forms, comments inside a list, no push event, no `on:` block, a
 * missing file. The last group reads the REAL deploy workflows, so a new shape
 * committed there fails here before either gate misreads it in production.
 */
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { readPushTrigger } from "../lib/workflow-triggers.js";

const dir = mkdtempSync(join(tmpdir(), "wf-triggers-"));
let n = 0;
function file(body: string): string {
  const p = join(dir, `wf-${n++}.yml`);
  writeFileSync(p, body);
  return p;
}

const PUBLISH = `name: Publish
on:
  push:
    branches: [main]
    tags:
      - "relay-v*"
  workflow_dispatch:

permissions:
  contents: read
`;

describe("readPushTrigger", () => {
  it("reads the publish shape: inline branches, no paths filter", () => {
    expect(readPushTrigger(file(PUBLISH))).toEqual({
      readable: true,
      push: true,
      branches: ["main"],
      paths: null,
      pathsIgnore: null,
    });
  });

  it("reads a block list with comment lines INSIDE it and after it (deploy-embed's shape)", () => {
    const t = readPushTrigger(
      file(`on:
  push:
    branches: [main]
    paths:
      - "services/embed/**"
      # A lockfile change must redeploy too.
      - "pnpm-lock.yaml"
      - 'package.json'
      # No packages/** trigger — see above.
  workflow_dispatch:
`),
    );
    expect(t).toMatchObject({
      push: true,
      branches: ["main"],
      paths: ["services/embed/**", "pnpm-lock.yaml", "package.json"],
    });
  });

  it("a paths-ignore filter is reported separately from paths", () => {
    const t = readPushTrigger(
      file(`on:
  push:
    branches: [main]
    paths-ignore:
      - "docs/**"
`),
    );
    expect(t).toMatchObject({ push: true, paths: null, pathsIgnore: ["docs/**"] });
  });

  it("branches in block form, quoted or bare, read the same as inline", () => {
    const block = readPushTrigger(
      file(`on:\n  push:\n    branches:\n      - "main"\n      - release\n`),
    );
    const inline = readPushTrigger(file(`on:\n  push:\n    branches: ["main", release]\n`));
    expect(block).toMatchObject({ branches: ["main", "release"] });
    expect(inline).toMatchObject({ branches: ["main", "release"] });
  });

  it("no branches key means every branch — null, not []", () => {
    expect(readPushTrigger(file(`on:\n  push:\n    paths:\n      - "x/**"\n`))).toMatchObject({
      branches: null,
      paths: ["x/**"],
    });
  });

  it("keys nested deeper than the push block are not the push block's keys", () => {
    // A `paths:` under some other event must not be read as push's.
    const t = readPushTrigger(
      file(`on:\n  push:\n    branches: [main]\n  pull_request:\n    paths:\n      - "a/**"\n`),
    );
    expect(t).toMatchObject({ push: true, paths: null });
  });

  it("an on: block without push is readable and push: false", () => {
    expect(
      readPushTrigger(file(`on:\n  schedule:\n    - cron: "1 2 * * *"\n  workflow_dispatch:\n`)),
    ).toEqual({
      readable: true,
      push: false,
    });
  });

  it("no on: block, and a missing file, are NOT readable — never 'no trigger'", () => {
    expect(readPushTrigger(file(`name: x\njobs: {}\n`))).toEqual({ readable: false });
    expect(readPushTrigger(join(dir, "does-not-exist.yml"))).toEqual({ readable: false });
  });

  it("the push block ends at the next event, so a later event's list is not push's", () => {
    const t = readPushTrigger(
      file(
        PUBLISH.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n    branches: [other]\n"),
      ),
    );
    expect(t).toMatchObject({ branches: ["main"] });
  });
});

describe("the real deploy workflows", () => {
  const wf = join(process.cwd(), ".github/workflows");
  const deploys = readdirSync(wf).filter((f) => /^deploy-(?!freshness)/.test(f));

  it("exist", () => {
    expect(deploys.length).toBeGreaterThan(3);
  });

  for (const f of deploys) {
    it(`${f}: push on main with a non-empty paths filter of globs`, () => {
      const t = readPushTrigger(join(wf, f));
      expect(t).toMatchObject({ readable: true, push: true, branches: ["main"] });
      if (!t.readable || !t.push) return;
      expect(t.paths).not.toBeNull();
      expect(t.paths!.length).toBeGreaterThan(0);
      for (const p of t.paths!) expect(p).not.toMatch(/^#|^\s*$|["']/);
    });
  }

  it("publish-images.yml: push on main with NO paths filter (what check-image-provenance relies on)", () => {
    expect(readPushTrigger(join(wf, "publish-images.yml"))).toMatchObject({
      push: true,
      branches: ["main"],
      paths: null,
      pathsIgnore: null,
    });
  });
});
