/**
 * `motebit-verify repo-change` (CI-on-PR mode, spec/repo-change-v1.md §7, §9)
 * over real fixture repositories: one positive control, then one failing case
 * per input source — the bundle, the entries, the path policy (read at the
 * base, never the head), the pins, the revocations, spent — and per shape
 * check, each asserting the rule's code or shape text, so removing the
 * computation of that input turns its test red (the repo-root tamper file
 * `verify-repo-change.ts`). A failing shape check still reports every
 * axis. Isolation: a repository whose own config runs a program is read
 * without running it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isFullyVerified } from "@motebit/verifier";
import type { RepoChangeVerification } from "@motebit/verifier";

import { verifyRepoChangePullRequest } from "../git/index.js";
import type { RepoChangeReport } from "../git/index.js";
import { DOC, NOW, POLICY, argsFor, fixture, git } from "./helpers/repo-change-fixture.js";
import type { Fixture, FixtureOptions } from "./helpers/repo-change-fixture.js";
import { runMain } from "./helpers/run-main.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-repo-change-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function judge(
  o: FixtureOptions = {},
  over: Parameters<typeof argsFor>[1] = {},
): Promise<{ fx: Fixture; r: RepoChangeReport }> {
  const fx = await fixture(tmp, o);
  return { fx, r: await verifyRepoChangePullRequest(argsFor(fx, over)) };
}

function codes(v: RepoChangeVerification): string[] {
  return v.diagnostics.failures.map((f) => f.code);
}

function expectRule(r: RepoChangeReport, code: string, site?: string): void {
  const v = r.verification;
  const hit = v.diagnostics.failures.some(
    (f) => f.code === code && (site === undefined || f.detail.includes(site)),
  );
  expect(
    hit,
    `${code}${site ? ` (${site})` : ""} in ${JSON.stringify(v.diagnostics.failures)}`,
  ).toBe(true);
  expect(isFullyVerified(v.verdict)).toBe(false);
  expect(r.accepted).toBe(false);
}

function expectShape(r: RepoChangeReport, text: string): void {
  expectRule(r, "integrity.repo_change.shape_check_failed", text);
}

// -- Positive control ------------------------------------------------------

describe("motebit-verify repo-change: a governed pull request", () => {
  it("is fully verified, pinned, fresh, with outcome completed", async () => {
    const { fx, r } = await judge();
    expect(r.verification.diagnostics.failures).toEqual([]);
    expect(r.computed.shapeFailures).toEqual([]);
    expect(r.computed.state.problems).toEqual([]);
    expect(isFullyVerified(r.verification.verdict)).toBe(true);
    expect(r.verification.verdict.identityBinding).toBe("pinned");
    expect(r.verification.verdict.revocation.status).toBe("fresh");
    expect(r.verification.verdict.temporalBasis).toBe("local_clock");
    expect(r.verification.outcome).toBe("completed");
    expect(r.accepted).toBe(true);
    expect(r.computed.changeCommit).toBe(fx.change);
    expect(r.computed.bundlePath).toBe(fx.bundleFile);
    // The bundle is the committed bytes, exactly.
    expect(Buffer.from(r.computed.input.bundle).equals(Buffer.from(fx.bundleBytes))).toBe(true);
    expect(r.computed.input.revocations?.readAt).toBe(fx.base);
  });

  it("reads a bare clone the same way", async () => {
    const fx = await fixture(tmp);
    const bare = path.join(tmp, "bare.git");
    git(tmp, "clone", "-q", "--bare", fx.repo, bare);
    git(bare, "fetch", "-q", fx.repo, `${fx.head}:refs/pr/head`);
    const r = await verifyRepoChangePullRequest(argsFor(fx, { repo: bare }));
    expect(r.verification.diagnostics.failures).toEqual([]);
    expect(r.accepted).toBe(true);
  });
});

// -- One failing case per input source ----------------------------------------

describe("motebit-verify repo-change: every input source can fail the verdict", () => {
  it("the bundle: an extra key", async () => {
    const { r } = await judge({ bundle: (b) => (b.extra = 1) });
    expectRule(r, "integrity.repo_change.bundle_malformed");
  });

  it("the entries: a change outside the scope", async () => {
    const { r } = await judge({ extraChange: { "src/code.ts": "export const x = 2;\n" } });
    expectRule(r, "authority.repo_change.entry_path_not_allowed", "src/code.ts");
  });

  it("the path policy: read at the base, never from the head that widens it", async () => {
    const narrow = JSON.stringify({
      spec: "motebit/repo-path-policy@1.0",
      include: ["src/*.ts"],
      exclude: [".motebit"],
    });
    // The base refuses notes/; the pull request's own tree permits it.
    const { r } = await judge({ basePolicy: narrow, headPolicy: POLICY });
    expect(r.computed.input.isPathPermitted(DOC)).toBe(false);
    expectRule(r, "authority.repo_change.scope_path_not_permitted", DOC);
    expectRule(r, "authority.repo_change.entry_path_not_permitted", DOC);
  });

  it("the pins: a missing principal pin", async () => {
    const { r } = await judge({ principalPin: false });
    expect(r.computed.input.pins.principal).toBeNull();
    expect(r.computed.state.problems.join("\n")).toMatch(/no principal pin/);
    expectRule(r, "identity.repo_change.delegator_not_principal");
    expect(r.verification.verdict.identityBinding).toBe("invalid");
  });

  it("the revocations: a revoked grant", async () => {
    const { r } = await judge({ revoked: true });
    expectRule(r, "revocation.repo_change.revoked");
    expect(r.verification.verdict.revocation.status).toBe("revoked");
  });

  it("the revocations: a file at the base that fails strict parsing is unchecked, never fresh", async () => {
    const { r } = await judge({ baseExtra: { ".motebit/revocations/junk.json": "not json" } });
    expectRule(r, "revocation.repo_change.set_malformed", "junk.json");
    expect(r.verification.verdict.revocation.status).toBe("unchecked");
  });

  it("spent: the bundle path once existed on the base's first-parent history", async () => {
    const { r } = await judge({ spent: true });
    expect(r.computed.input.spent).toBe(true);
    expectRule(r, "authority.repo_change.grant_spent");
  });

  it("the tracked paths: the base's tree (a case collision with a tracked path)", async () => {
    // Fullwidth `ｇ` (U+FF47) folds to `g` under NFKC: a different file on
    // disk, the same path to the case rule.
    const { r } = await judge({ baseExtra: { "notes/\uff47uide.md": "other\n" } });
    expectRule(r, "authority.repo_change.entry_case_collision", DOC);
  });
});

// -- Every shape check ---------------------------------------------------------

describe("motebit-verify repo-change: every shape check folds into integrity", () => {
  it("parent_commit is not the base (main moved on)", async () => {
    const { r } = await judge({ mainMovesOn: true });
    expectShape(r, "parent_commit is not the tip of the base ref");
    expectShape(r, "not exactly the change commit and the bundle commit");
  });

  it("three commits, not two", async () => {
    const { r } = await judge({ threeCommits: true });
    expectShape(r, "not exactly the change commit and the bundle commit");
  });

  it("head_commit is not the bundle commit's parent", async () => {
    const { r } = await judge({ recordHeadCommit: "f".repeat(40) });
    expectShape(r, "head_commit is not the bundle commit's parent");
  });

  it("an extra entry in the bundle commit", async () => {
    const { r } = await judge({ bundleCommitExtra: { "notes/extra.md": "x\n" } });
    expectShape(r, "head_commit..bundle_commit is not exactly one A 100644");
  });

  it("an edit under .motebit/bundles/", async () => {
    const fx = await fixture(tmp, { otherBundle: true });
    // A follow-up PR whose bundle commit also rewrites a landed bundle.
    git(fx.repo, "checkout", "-q", "pr");
    fs.writeFileSync(path.join(fx.repo, ".motebit/bundles/landed.json"), '{"x":1}');
    git(fx.repo, "commit", "-q", "--amend", "-a", "--no-edit");
    const head = git(fx.repo, "rev-parse", "HEAD");
    git(fx.repo, "checkout", "-q", "main");
    const r = await verifyRepoChangePullRequest(argsFor(fx, { head }));
    expectShape(r, 'modifies or deletes ".motebit/bundles/landed.json"');
  });

  it("the wrong author", async () => {
    const { r } = await judge({}, { prAuthor: "someone-else" });
    expectShape(r, "author is not motebit-agent");
  });

  it("the wrong base ref", async () => {
    const { r } = await judge({}, { baseRef: "develop" });
    expectShape(r, "the base ref is not main");
  });

  it("the wrong repository", async () => {
    const { r } = await judge({}, { repository: "someone/fork" });
    expectRule(r, "authority.repo_change.repo_mismatch");
  });

  it("a pull request that adds no bundle (its head is the change commit)", async () => {
    const fx = await fixture(tmp);
    const r = await verifyRepoChangePullRequest(argsFor(fx, { head: fx.change }));
    expectShape(r, "does not add exactly one regular file under .motebit/bundles/ (it adds 0)");
    expectShape(
      r,
      "head_commit..bundle_commit is not exactly one A 100644 at .motebit/bundles/<grant_id>.json",
    );
    expectRule(r, "integrity.repo_change.bundle_malformed");
    expect(r.computed.bundlePath).toBeNull();
  });

  it("a pull request head with no parent", async () => {
    const fx = await fixture(tmp);
    const r = await verifyRepoChangePullRequest(argsFor(fx, { head: fx.base }));
    expectShape(r, "the pull request head is not one non-merge commit");
    expect(r.computed.changeCommit).toBeNull();
    expect(r.computed.input.entries).toEqual([]);
  });

  it("a change entry under .motebit/bundles/", async () => {
    const { r } = await judge({ extraChange: { ".motebit/bundles/sneaky.json": "{}" } });
    expectShape(r, "a change entry touches .motebit/bundles/");
  });

  it("a bundle whose grant id is not a lowercase UUID, or that is not JSON, or whose result is not JSON", async () => {
    const odd = await judge({
      bundle: (b) => (b.grant = { ...(b.grant as object), grant_id: "NOT-A-UUID" }),
    });
    expect(odd.r.computed.input.spent).toBe(false);
    expectShape(
      odd.r,
      "head_commit..bundle_commit is not exactly one A 100644 at .motebit/bundles/NOT-A-UUID.json",
    );
    const junk = await judge({ bytes: () => new TextEncoder().encode("not json") });
    expectShape(junk.r, "parent_commit is not the tip of the base ref");
    expectRule(junk.r, "integrity.repo_change.bundle_malformed");
    const result = await judge({
      bundle: (b) => (b.receipt = { ...(b.receipt as object), result: "not json" }),
    });
    expectShape(result.r, "parent_commit is not the tip of the base ref");
  });

  it("a sha256 clone is opened as sha256 (a 64-hex base)", async () => {
    const repo = path.join(tmp, "sha256");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main", "--object-format=sha256");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const base = git(repo, "rev-parse", "HEAD");
    // No policy at the base: not judged — but the session read the sha256 tree to say so.
    await expect(
      verifyRepoChangePullRequest({
        ...argsFor({ repo, base, head: base } as Fixture),
        repo,
        base,
        head: base,
      }),
    ).rejects.toThrow("the path policy at the base cannot be used");
  });

  it("a failing shape check still reports every axis", async () => {
    const { r } = await judge({}, { prAuthor: "someone-else" });
    const v = r.verification;
    expect(codes(v)).toEqual(["integrity.repo_change.shape_check_failed"]);
    expect(v.verdict.integrity).toBe("invalid");
    expect(v.verdict.identityBinding).toBe("pinned");
    expect(v.verdict.authority).toBe("valid");
    expect(v.verdict.revocation.status).toBe("fresh");
    expect(v.outcome).toBe("completed");
  });
});

// -- Isolation -------------------------------------------------------------------

describe("motebit-verify repo-change: the repository's own config is never read", () => {
  it("a core.fsmonitor program in .git/config never runs, and a config git cannot parse is never read", async () => {
    const fx = await fixture(tmp);
    const marker = path.join(tmp, "fsmonitor-ran");
    const script = path.join(tmp, "fsmonitor.sh");
    fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`, { mode: 0o755 });
    git(fx.repo, "config", "core.fsmonitor", script);
    git(fx.repo, "config", "core.hooksPath", tmp);
    // Control: the config is armed — an ordinary git call runs the program.
    git(fx.repo, "status", "--porcelain");
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    const r = await verifyRepoChangePullRequest(argsFor(fx));
    expect(r.accepted).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    // A line git refuses to parse: any git that read this config would fail.
    fs.appendFileSync(path.join(fx.repo, ".git", "config"), "[core\n\tbroken = \n");
    expect(() => git(fx.repo, "status")).toThrow();
    const r2 = await verifyRepoChangePullRequest(argsFor(fx));
    expect(r2.accepted).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

// -- The command ------------------------------------------------------------------

function cliArgs(fx: Fixture, extra: string[] = []): string[] {
  const a = argsFor(fx);
  return [
    "repo-change",
    "--repo",
    a.repo,
    "--base",
    a.base,
    "--head",
    a.head,
    "--repository",
    a.repository,
    "--base-ref",
    a.baseRef,
    "--pr-author",
    a.prAuthor,
    ...extra,
  ];
}

describe("motebit-verify repo-change: the command", () => {
  it("exits 0 on a verified completed change, printing every axis", async () => {
    const fx = await fixture(tmp);
    const out = await runMain(cliArgs(fx, ["--now", String(NOW)]));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/repo-change VERIFIED/);
    expect(out.stdout).toMatch(
      /integrity verified, identityBinding pinned, authority valid, revocation fresh; outcome completed/,
    );
    expect(out.stdout).toContain(`evaluated at   ${NOW} (local_clock)`);
  });

  it("--json is the structured verdict, with the evaluation time and basis", async () => {
    const fx = await fixture(tmp);
    const out = await runMain(cliArgs(fx, ["--now", String(NOW), "--json"]));
    expect(out.code).toBe(0);
    const j = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(j.accepted).toBe(true);
    expect(j.evaluatedAt).toBe(NOW);
    expect(j.temporalBasis).toBe("local_clock");
    expect(j.bundlePath).toBe(fx.bundleFile);
    expect(j.changeCommit).toBe(fx.change);
    expect(j.shapeFailures).toEqual([]);
  });

  it("the local clock when --now is absent: the fixture grant is not valid now, exit 1", async () => {
    // The fixture's tick expires in 2030; this machine's clock is earlier, so
    // the grant is not yet valid — either way not `valid`, never accepted.
    const fx = await fixture(tmp);
    const out = await runMain(cliArgs(fx, ["--json"]));
    expect(out.code).toBe(1);
    const j = JSON.parse(out.stdout) as { verdict: { authority: string }; evaluatedAt: number };
    expect(j.verdict.authority).not.toBe("valid");
    expect(Math.abs(j.evaluatedAt - Date.now())).toBeLessThan(60_000);
  });

  it("exits 1 on a verdict failure, naming the rule", async () => {
    const fx = await fixture(tmp, { principalPin: false });
    const out = await runMain(cliArgs(fx, ["--now", String(NOW)]));
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/NOT VERIFIED/);
    expect(out.stdout).toMatch(/identity\.repo_change\.delegator_not_principal/);
    expect(out.stdout).toMatch(/no principal pin/);
  });

  it("prints `none` for what a malformed pull request does not have", async () => {
    const fx = await fixture(tmp);
    const out = await runMain(
      cliArgs(fx, ["--now", String(NOW)]).map((a) => (a === fx.head ? fx.base : a)),
    );
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("change commit  none");
    expect(out.stdout).toContain("bundle         none");
    expect(out.stdout).toMatch(/outcome none/);
  });

  it("exits 2 when the change cannot be judged: no path policy at the base", async () => {
    const fx = await fixture(tmp, { basePolicy: "not json" });
    const out = await runMain(cliArgs(fx, ["--now", String(NOW)]));
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/not judged: the path policy at the base/);
  });

  it("exits 2 on an I/O error: a commit the clone does not hold", async () => {
    const fx = await fixture(tmp);
    const out = await runMain([
      ...cliArgs(fx).map((a) => (a === fx.head ? "0".repeat(40) : a)),
      "--now",
      String(NOW),
    ]);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/not judged/);
  });

  it.each([
    [[], /missing --repo/],
    [
      [
        ...["--repo", "x", "--base", "x", "--head", "x", "--repository", "o/n"],
        ...["--base-ref", "main", "--pr-author", "motebit-agent"],
      ],
      /--base must be a full lowercase commit id/,
    ],
    [["--bogus"], /unknown flag: --bogus/],
    [["stray"], /unexpected argument: stray/],
    [["--repo"], /--repo requires a value/],
    [["--repo", "a", "--repo", "b"], /--repo given twice/],
  ])("exits 2 on a usage error %#", async (argv, message) => {
    const out = await runMain(["repo-change", ...argv]);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(message);
  });

  it("exits 2 on a malformed --head or --now", async () => {
    const fx = await fixture(tmp);
    const head = await runMain(cliArgs(fx).map((a) => (a === fx.head ? "abc" : a)));
    expect(head.code).toBe(2);
    expect(head.stderr).toMatch(/--head must be a full lowercase commit id/);
    const now = await runMain(cliArgs(fx, ["--now", "-5"]));
    expect(now.code).toBe(2);
    const now2 = await runMain(cliArgs(fx, ["--now", "1.5"]));
    expect(now2.code).toBe(2);
    expect(now2.stderr).toMatch(/--now must be milliseconds/);
  });

  it("--help prints the repo-change section", async () => {
    const out = await runMain(["repo-change", "--help"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/REPO-CHANGE MODE/);
  });
});
