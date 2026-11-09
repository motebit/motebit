/**
 * scripts/governed-change-fixture.ts — the negative acceptance tests B3, B4,
 * B5a, B5b and B6 (docs/proposals/governed-repo-change-v1.md).
 *
 * Throwaway repositories, ephemeral keys for the principal F and the agent
 * A, scripted edits (never a model), and HOME redirected to an empty temp
 * home whose `~/.motebit/config.json` is unreadable (mode 000): any read of
 * the principal's config throws, so F's key is never reachable. The judge of
 * each output is `verifyRepoChangePullRequest` (CI-on-PR mode) run here,
 * independently of the script's own self-check, against expectations
 * written out below — not the script's table.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const HOME = vi.hoisted(async () => {
  const nfs = await import("node:fs");
  const nos = await import("node:os");
  const npath = await import("node:path");
  const home = nfs.realpathSync(nfs.mkdtempSync(npath.join(nos.tmpdir(), "gc-fixture-home-")));
  process.env.HOME = home;
  delete process.env.MOTEBIT_CONFIG_DIR;
  delete process.env.MOTEBIT_PASSPHRASE;
  delete process.env.MOTEBIT_AGENT_PASSPHRASE;
  return home;
});

import { loadActiveSigningKey } from "../../apps/cli/src/identity.js";
import { defaultConfigDirs } from "../../apps/cli/src/repo-task/agent-identity.js";
import { runGovernedRepoTask } from "../../apps/cli/src/repo-task/run-command.js";
import {
  FIXTURE_CASES,
  TICK_MARGIN_MS,
  cliRuntimeVersion,
  commitBundleOverLanded,
  expectedVerdict,
  governedChangeFixtureCommand,
  judge,
  nodeFixtureDeps,
  respellBase64Url,
} from "../governed-change-fixture.js";
import type { FixtureCase } from "../governed-change-fixture.js";
import { cleanEnv } from "../lib/differential-tree.js";
import {
  DOC,
  ExitCalled,
  FIX_TURNS,
  HOUR,
  NOW,
  OUTSIDE,
  PASS,
  REPO,
  agentConfigOf,
  encryption,
  field,
  fixtureArgs,
  fixtureRepo,
  fromCli,
  git,
  gitBytes,
  gitVars,
  harness,
  homeState,
  party,
  refState,
  scripted,
  snapshot,
  verifyGit,
} from "./governed-change-fixture-helpers.js";
import type {
  Env,
  FixtureRepo,
  FixtureRepoOptions,
  Harness,
} from "./governed-change-fixture-helpers.js";

const LONG = { timeout: 120_000 };

let env: Env;
let tmp = "";

beforeAll(async () => {
  const home = await HOME;
  // The principal's own ~/.motebit: present, and unreadable — a read throws.
  fs.mkdirSync(path.join(home, ".motebit"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".motebit", "config.json"), "{}", { mode: 0o000 });
  const f = await party();
  const a = await party();
  const agentRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gc-fixture-agent-")));
  fs.writeFileSync(path.join(agentRoot, "config.json"), JSON.stringify(await agentConfigOf(a)));
  env = { home, f, a, agentDir: agentRoot };
}, 60_000);
afterAll(() => {
  fs.chmodSync(path.join(env.home, ".motebit", "config.json"), 0o600);
  fs.rmSync(env.home, { recursive: true, force: true });
  fs.rmSync(env.agentDir, { recursive: true, force: true });
});
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gc-fixture-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The repository each case runs against. */
const SETUP: Record<FixtureCase, FixtureRepoOptions> = {
  b3: {},
  b4: {},
  b5a: {},
  b5b: { landed: true },
  b6: { revoked: true },
};

/**
 * What CI must say about each case's pull request — written out here, never
 * read from the script. Every axis but the case's own is a valid change's.
 */
const VALID = {
  integrity: "verified",
  identityBinding: "pinned",
  authority: "valid",
  revocation: "fresh",
  outcome: "completed",
  spent: false,
};
const EXPECT: Record<FixtureCase, typeof VALID & { codes: string[] }> = {
  b3: {
    ...VALID,
    authority: "insufficient",
    codes: ["authority.repo_change.entry_path_not_allowed"],
  },
  b4: {
    ...VALID,
    identityBinding: "invalid",
    codes: ["identity.repo_change.signer_not_delegate"],
  },
  b5a: {
    ...VALID,
    integrity: "invalid",
    codes: ["integrity.repo_change.value_not_canonical"],
  },
  b5b: {
    ...VALID,
    integrity: "invalid",
    authority: "insufficient",
    spent: true,
    codes: ["authority.repo_change.grant_spent", "integrity.repo_change.shape_check_failed"],
  },
  b6: { ...VALID, revocation: "revoked", codes: ["revocation.repo_change.revoked"] },
};

async function ciVerdict(fx: FixtureRepo, head: string) {
  const { verifyRepoChangePullRequest } = await verifyGit();
  return verifyRepoChangePullRequest({
    repo: fx.repo,
    base: fx.tip,
    head,
    repository: REPO,
    baseRef: "main",
    prAuthor: "motebit-agent",
    now: NOW,
  });
}

function axes(r: Awaited<ReturnType<typeof ciVerdict>>) {
  const v = r.verification.verdict;
  return {
    integrity: v.integrity,
    identityBinding: v.identityBinding,
    authority: v.authority,
    revocation: v.revocation.status,
    outcome: r.verification.outcome,
    spent: r.computed.input.spent,
    codes: [...new Set(r.verification.diagnostics.failures.map((f) => f.code))].sort(),
  };
}

const zeroed = (k: Uint8Array): boolean => k.every((b) => b === 0);

/** A's key unlocked exactly once from A's config and erased; or (b4) never unlocked, the ephemeral key erased. */
function expectKeysHandled(h: Harness, c: FixtureCase): void {
  if (c === "b4") {
    expect(h.events).not.toContain("unlock");
    expect(h.loaded).toHaveLength(0);
    expect(h.ephemeral).toHaveLength(1);
    expect(h.erased).toEqual([h.ephemeral[0]]);
    expect(zeroed(h.ephemeral[0]!)).toBe(true);
  } else {
    expect(h.events).not.toContain("ephemeral");
    expect(h.loaded).toHaveLength(1);
    expect(h.erased).toEqual([h.loaded[0]]);
    expect(zeroed(h.loaded[0]!)).toBe(true);
    // Only A's identity and key fields reach the loader; never F's.
    expect(h.configs).toEqual([
      expect.objectContaining({
        motebit_id: env.a.pin.motebit_id,
        device_public_key: env.a.pin.public_key,
      }),
    ]);
    expect(Object.keys(h.configs[0]!).sort()).toEqual(
      ["cli_encrypted_key", "device_id", "device_public_key", "motebit_id"].sort(),
    );
  }
}

async function expectRefused(h: Harness, run: () => Promise<void>, text: RegExp): Promise<void> {
  await expect(run()).rejects.toBeInstanceOf(ExitCalled);
  expect(h.events.at(-1)).toBe("exit 1");
  expect(h.errors.join("\n")).toMatch(text);
  expect(h.lines.join("\n")).not.toMatch(/git push/);
}

// -- Each case: exactly its one defect ---------------------------------------------

describe("governed-change fixture: each case makes exactly its one defect", LONG, () => {
  it.each(FIXTURE_CASES)(
    "%s: two unreachable commits, the push command, and exactly the expected verdict in CI",
    async (c) => {
      const fx = await fixtureRepo(env, tmp, SETUP[c]);
      const h = harness();
      const refsBefore = refState(env.home, fx.repo);
      const worktreeBefore = snapshot(fx.repo);
      const homeBefore = homeState(env.home);

      await governedChangeFixtureCommand(fixtureArgs(env, fx, c), h.deps);

      const parent = field(h.lines, "parent_commit");
      const head = field(h.lines, "head_commit");
      const bundleCommit = field(h.lines, "bundle_commit");
      expect(parent).toBe(fx.tip);
      expect(git(env.home, fx.repo, "rev-parse", `${head}^`)).toBe(fx.tip);
      expect(git(env.home, fx.repo, "rev-parse", `${bundleCommit}^`)).toBe(head);
      // Unreachable: no ref names either commit.
      expect(git(env.home, fx.repo, "for-each-ref", "--contains", head)).toBe("");
      expect(git(env.home, fx.repo, "for-each-ref", "--contains", bundleCommit)).toBe("");
      expect(h.lines.join("\n")).toContain(
        `git push <publisher-remote> ${bundleCommit}:refs/heads/repo-task/${fx.grantId}-${c}`,
      );
      expect(h.events).not.toContain("exit 1");
      // What the publish needs to stay this verdict, and the build it was judged with.
      const out = h.lines.join("\n");
      expect(out).toContain("must be opened by motebit-agent");
      expect(out).toContain(
        "the pull request's title and body must not contain the word \"committer\": GitHub's merge queue re-wraps the squash message",
      );
      expect(out).toContain(`main's tip must still be ${fx.tip} when CI runs`);
      expect(out).toMatch(
        /rebuild the verifier .*pnpm --filter @motebit\/verifier --filter @motebit\/verify build/,
      );

      // CI's verdict, computed here: the case's axis, and only it, fails.
      const r = await ciVerdict(fx, bundleCommit);
      const { codes, ...rest } = EXPECT[c];
      expect(axes(r)).toEqual({ ...rest, codes });
      expect(r.accepted).toBe(false);

      // The defect itself, in the objects.
      const bundleFile = `.motebit/bundles/${fx.grantId}.json`;
      const bundle = JSON.parse(
        gitBytes(env.home, fx.repo, "cat-file", "blob", `${bundleCommit}:${bundleFile}`).toString(),
      ) as {
        tick: { signature: string };
        receipt: { public_key: string; motebit_id: string };
        tool_receipts: { public_key: string; motebit_id: string }[];
      };
      const signedTick = JSON.parse(
        fs.readFileSync(path.join(fx.delegation, "tick.json"), "utf8"),
      ) as { signature: string };
      const changed = git(
        env.home,
        fx.repo,
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--name-status",
        fx.tip,
        head,
      );
      const bundleChange = git(
        env.home,
        fx.repo,
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--name-status",
        head,
        bundleCommit,
      );
      expect(bundleChange).toBe(`${c === "b5b" ? "M" : "A"}\t${bundleFile}`);
      expect(changed).toBe(c === "b3" ? `A\t${OUTSIDE}\nM\t${DOC}` : `M\t${DOC}`);
      if (c === "b5a") {
        expect(bundle.tick.signature).not.toBe(signedTick.signature);
        expect(Buffer.from(bundle.tick.signature, "base64url")).toEqual(
          Buffer.from(signedTick.signature, "base64url"),
        );
      } else {
        expect(bundle.tick.signature).toBe(signedTick.signature);
      }
      const signers = new Set([
        bundle.receipt.public_key,
        ...bundle.tool_receipts.map((t) => t.public_key),
      ]);
      expect(signers.size).toBe(1);
      expect(signers.has(env.a.pin.public_key)).toBe(c !== "b4");
      expect(bundle.receipt.motebit_id).toBe(env.a.pin.motebit_id);

      // The keys; no ref moved, the worktree byte-identical, ~/.motebit untouched.
      expectKeysHandled(h, c);
      expect(refState(env.home, fx.repo)).toEqual(refsBefore);
      expect(snapshot(fx.repo)).toEqual(worktreeBefore);
      expect(homeState(env.home)).toBe(homeBefore);
    },
  );
});

// -- Refusals ---------------------------------------------------------------------------

describe(
  "governed-change fixture: no push command when the defect is absent or a second one is present",
  LONG,
  () => {
    it("a valid change's verdict is no case's expectation: each differs on exactly its own axis", async () => {
      const fx = await fixtureRepo(env, tmp);
      const report = await runGovernedRepoTask(
        {
          agentDir: env.agentDir,
          delegationDir: fx.delegation,
          repoDir: fx.repo,
          providerName: "test",
        },
        {
          loadActiveSigningKey: (c, o) => loadActiveSigningKey(c, o),
          secureErase: (k) => k.fill(0),
          createProvider: () => scripted(FIX_TURNS),
          getPassphrase: async () => PASS,
          defaultConfigDirs: () => defaultConfigDirs(),
          now: () => NOW,
          runtimeVersion: "motebit test",
        },
      );
      const r = await ciVerdict(fx, report.bundleCommit);
      expect(r.accepted).toBe(true);
      const own: Record<FixtureCase, string[]> = {
        b3: ["authority"],
        b4: ["identityBinding"],
        b5a: ["integrity"],
        b5b: ["integrity", "authority", "spent", "shape failures"],
        b6: ["revocation"],
      };
      for (const c of FIXTURE_CASES) {
        const want = expectedVerdict(c, {
          grantId: fx.grantId,
          changeCommit: report.headCommit,
          toolReceipts: 2,
          outsidePath: OUTSIDE,
        });
        const j = judge(want, r.computed, r.verification);
        expect(j.matches, c).toBe(false);
        expect(
          j.rows.filter((row) => !row.ok).map((row) => row.name),
          c,
        ).toEqual(own[c]);
        expect(j.unexpected, c).toEqual([]);
        expect(j.missing, c).toEqual(want.failures);
      }
    });

    it.each(FIXTURE_CASES)(
      "%s: a tick that expires before the self-check is a second defect, and refused",
      async (c) => {
        const fx = await fixtureRepo(env, tmp, SETUP[c]);
        let clock = NOW;
        // The key is erased right after the record is signed: the clock then
        // passes the tick's expiry before the bundle commit and the self-check.
        const h = harness({
          now: () => clock,
          onErase: () => {
            clock = NOW + 2 * HOUR;
          },
        });
        const refsBefore = refState(env.home, fx.repo);
        await expectRefused(
          h,
          () => governedChangeFixtureCommand(fixtureArgs(env, fx, c), h.deps),
          new RegExp(`not exactly ${c}'s expectation`),
        );
        expect(h.lines.join("\n")).toMatch(
          /DIFF not expected: authority\.repo_change\.tick_expired/,
        );
        expectKeysHandled(h, c);
        expect(refState(env.home, fx.repo)).toEqual(refsBefore);
      },
    );

    it("b3: a record that omits the out-of-scope entry adds entries_mismatch, which is not b3", async () => {
      // The design wants A to sign the record over the REAL entries, so that
      // the only failure is the out-of-scope path. A record that leaves it out
      // is a second defect (entries_mismatch) and must not pass as B3.
      const fx = await fixtureRepo(env, tmp);
      const h = harness();
      await governedChangeFixtureCommand(fixtureArgs(env, fx, "b3"), h.deps);
      const head = field(h.lines, "head_commit");
      const bundleFile = `.motebit/bundles/${fx.grantId}.json`;
      const bytes = gitBytes(
        env.home,
        fx.repo,
        "cat-file",
        "blob",
        `${field(h.lines, "bundle_commit")}:${bundleFile}`,
      );
      const bundle = JSON.parse(bytes.toString()) as Record<string, unknown> & {
        receipt: Record<string, unknown> & { result: string };
      };
      const enc = await encryption();
      const record = JSON.parse(bundle.receipt.result) as { entries: { path: string }[] };
      record.entries = record.entries.filter((e) => e.path !== OUTSIDE);
      const result = enc.canonicalJson(record);
      const { signature: _s, suite: _u, public_key: _p, ...unsigned } = bundle.receipt;
      const receipt = await enc.signExecutionReceipt(
        {
          ...(unsigned as Parameters<typeof enc.signExecutionReceipt>[0]),
          result,
          result_hash: await enc.hash(new TextEncoder().encode(result)),
        },
        env.a.keys.privateKey,
        env.a.keys.publicKey,
      );
      const forgedBytes = Buffer.from(enc.canonicalJson({ ...bundle, receipt }));
      // A sibling bundle commit on the same change commit, on a private index.
      const genv = cleanEnv(
        {},
        { ...gitVars(env.home), GIT_INDEX_FILE: path.join(tmp, "forge-index") },
      );
      const run = (argv: string[], input?: Buffer) =>
        execFileSync("git", argv, { cwd: fx.repo, env: genv, input, encoding: "utf8" }).trim();
      const blob = run(["hash-object", "-w", "--stdin"], forgedBytes);
      run(["read-tree", head]);
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${bundleFile}`]);
      const forged = run(["commit-tree", run(["write-tree"]), "-p", head, "-m", "bundle"]);
      const r = await ciVerdict(fx, forged);
      expect(axes(r).codes).toEqual([
        "authority.repo_change.entries_mismatch",
        "authority.repo_change.entry_path_not_allowed",
      ]);
      const j = judge(
        expectedVerdict("b3", {
          grantId: fx.grantId,
          changeCommit: head,
          toolReceipts: 2,
          outsidePath: OUTSIDE,
        }),
        r.computed,
        r.verification,
      );
      expect(j.matches).toBe(false);
      expect(j.unexpected.map((f) => f.code)).toEqual(["authority.repo_change.entries_mismatch"]);
    });

    it("b3: a scope of max_changed_files 1 would add entries_exceed_max, so it refuses before the key", async () => {
      const fx = await fixtureRepo(env, tmp, { maxChangedFiles: 1 });
      const h = harness();
      await expectRefused(
        h,
        () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b3"), h.deps),
        /needs max_changed_files >= 2/,
      );
      expect(h.events).toEqual(["exit 1"]);
    });

    it("b3: a grant also revoked at the tip is a second defect, refused before the key", async () => {
      const fx = await fixtureRepo(env, tmp, { revoked: true });
      const h = harness();
      await expectRefused(
        h,
        () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b3"), h.deps),
        /revocation\.repo_change\.revoked/,
      );
      expect(h.events).toEqual(["exit 1"]);
    });

    it("b5b: a grant whose bundle never landed has no defect to make, refused before the key", async () => {
      const fx = await fixtureRepo(env, tmp);
      const h = harness();
      await expectRefused(
        h,
        () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b5b"), h.deps),
        /records as spent/,
      );
      expect(h.events).toEqual(["exit 1"]);
    });

    it("b6: a grant with no landed revocation has no defect to make, refused before the key", async () => {
      const fx = await fixtureRepo(env, tmp);
      const h = harness();
      await expectRefused(
        h,
        () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b6"), h.deps),
        /records as revoked/,
      );
      expect(h.events).toEqual(["exit 1"]);
    });

    it("b6: a grant both revoked and spent is a second defect, refused before the key", async () => {
      const fx = await fixtureRepo(env, tmp, { landed: true, revoked: true });
      const h = harness();
      await expectRefused(
        h,
        () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b6"), h.deps),
        /records as revoked[\s\S]*authority\.repo_change\.grant_spent/,
      );
      expect(h.events).toEqual(["exit 1"]);
    });

    it("an unknown case, and an output directory inside the repository, are refused", async () => {
      const fx = await fixtureRepo(env, tmp);
      const h = harness();
      await expectRefused(
        h,
        () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b7"), h.deps),
        /--case must be one of/,
      );
      const h2 = harness();
      await expectRefused(
        h2,
        () =>
          governedChangeFixtureCommand(
            fixtureArgs(env, fx, "b3", { output: path.join(fx.repo, "out") }),
            h2.deps,
          ),
        /inside the repository/,
      );
      expect(fs.existsSync(path.join(fx.repo, "out"))).toBe(false);
      expect([...h.events, ...h2.events]).toEqual(["exit 1", "exit 1"]);
    });

    it("--author sets both commits' identity, as repo-task run's", async () => {
      const fx = await fixtureRepo(env, tmp);
      const h = harness();
      const given = "motebit-agent <agent@example.com>";
      await governedChangeFixtureCommand(fixtureArgs(env, fx, "b3", { author: given }), h.deps);
      const bundleCommit = field(h.lines, "bundle_commit");
      expect(
        git(
          env.home,
          fx.repo,
          "log",
          "--format=%an <%ae>|%cn <%ce>",
          `${fx.tip}..${bundleCommit}`,
        ).split("\n"),
      ).toEqual([`${given}|${given}`, `${given}|${given}`]);
      const h2 = harness();
      await expectRefused(
        h2,
        () =>
          governedChangeFixtureCommand(
            fixtureArgs(env, fx, "b3", { author: "no-brackets" }),
            h2.deps,
          ),
        /--author must be/,
      );
    });
  },
);

// -- The keys ------------------------------------------------------------------------------

describe("governed-change fixture: every key is erased on every exit path", LONG, () => {
  it("A's key, when the run refuses after the unlock", async () => {
    const fx = await fixtureRepo(env, tmp);
    // The preflight's clock is inside the window; the run's own check is not.
    let n = 0;
    const h = harness({ now: () => (n++ === 0 ? NOW : NOW + 2 * HOUR) });
    await expectRefused(
      h,
      () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b3"), h.deps),
      /the run refused to start/,
    );
    expect(h.erased).toEqual([h.loaded[0]]);
    expect(zeroed(h.loaded[0]!)).toBe(true);
    expect(h.events.slice(-2)).toEqual(["erase", "exit 1"]);
  });

  it("A's key, when the run throws", async () => {
    const fx = await fixtureRepo(env, tmp);
    let n = 0;
    const h = harness({
      now: () => {
        if (n++ === 0) return NOW;
        throw new Error("the clock broke");
      },
    });
    await expect(governedChangeFixtureCommand(fixtureArgs(env, fx, "b5a"), h.deps)).rejects.toThrow(
      /the clock broke/,
    );
    expect(h.erased).toEqual([h.loaded[0]]);
    expect(zeroed(h.loaded[0]!)).toBe(true);
    expect(h.events.at(-1)).toBe("erase");
  });

  it("b4's ephemeral key, when signing throws", async () => {
    const fx = await fixtureRepo(env, tmp);
    let n = 0;
    const h = harness({
      now: () => {
        if (n++ === 0) return NOW;
        throw new Error("the clock broke");
      },
    });
    await expect(governedChangeFixtureCommand(fixtureArgs(env, fx, "b4"), h.deps)).rejects.toThrow(
      /the clock broke/,
    );
    expect(h.events).not.toContain("unlock");
    expect(h.erased).toEqual([h.ephemeral[0]]);
    expect(zeroed(h.ephemeral[0]!)).toBe(true);
    expect(h.events.at(-1)).toBe("erase");
  });
});

// -- judge(): every row and every detail gate the push command -------------------------

describe("governed-change fixture: judge holds every row and every failure detail", () => {
  const CTX = {
    grantId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    changeCommit: "a".repeat(40),
    toolReceipts: 2,
  };
  /** A b5a verdict that matches its expectation exactly. */
  function matching() {
    const want = expectedVerdict("b5a", CTX);
    const computed = {
      input: { spent: false },
      bundlePath: want.bundlePath,
      changeCommit: want.changeCommit,
      shapeFailures: [] as string[],
    };
    const verification = {
      verdict: {
        integrity: "invalid",
        identityBinding: "pinned",
        authority: "valid",
        revocation: { status: "fresh" },
      },
      outcome: "completed",
      diagnostics: {
        failures: [
          {
            code: "integrity.repo_change.value_not_canonical",
            axis: "integrity",
            detail: "tick.signature is not canonical base64url",
          },
        ],
      },
    };
    return { want, computed, verification };
  }
  type Parts = ReturnType<typeof matching>;
  const verdictOf = (p: Parts) =>
    judge(
      p.want,
      p.computed as unknown as Parameters<typeof judge>[1],
      p.verification as unknown as Parameters<typeof judge>[2],
    );

  it("a verdict equal to the expectation matches", () => {
    expect(verdictOf(matching()).matches).toBe(true);
  });

  it.each<[string, (p: Parts) => void]>([
    [
      "the same code with another detail (value_not_canonical on receipt.signature)",
      (p) => {
        p.verification.diagnostics.failures[0]!.detail =
          "receipt.signature is not canonical base64url";
      },
    ],
    [
      "outcome failed",
      (p) => {
        p.verification.outcome = "failed";
      },
    ],
    [
      "another bundle path",
      (p) => {
        p.computed.bundlePath = ".motebit/bundles/other.json";
      },
    ],
    [
      "another change commit",
      (p) => {
        p.computed.changeCommit = "b".repeat(40);
      },
    ],
    [
      "the expected failure absent from the actual",
      (p) => {
        p.verification.diagnostics.failures.length = 0;
      },
    ],
  ])("one change, %s, is not a match", (_name, change) => {
    const p = matching();
    change(p);
    expect(verdictOf(p).matches).toBe(false);
  });

  it("b3: entry_path_not_allowed naming another path is not a match", () => {
    const want = expectedVerdict("b3", { ...CTX, outsidePath: "notes/a.md" });
    const computed = {
      input: { spent: false },
      bundlePath: want.bundlePath,
      changeCommit: want.changeCommit,
      shapeFailures: [] as string[],
    };
    const verification = (path: string) => ({
      verdict: {
        integrity: "verified",
        identityBinding: "pinned",
        authority: "insufficient",
        revocation: { status: "fresh" },
      },
      outcome: "completed",
      diagnostics: {
        failures: [
          {
            code: "authority.repo_change.entry_path_not_allowed",
            axis: "authority",
            detail: `${JSON.stringify(path)} is not an allowed path`,
          },
        ],
      },
    });
    const j = (path: string) =>
      judge(
        want,
        computed as unknown as Parameters<typeof judge>[1],
        verification(path) as unknown as Parameters<typeof judge>[2],
      ).matches;
    expect(j("notes/a.md")).toBe(true);
    expect(j("notes/b.md")).toBe(false);
  });
});

// -- Every guard refuses ----------------------------------------------------------------

describe("governed-change fixture: every preflight and postcondition guard refuses", LONG, () => {
  /** Refused, and no key was ever unlocked or generated. */
  async function refusedBeforeKey(h: Harness, args: string[], text: RegExp): Promise<void> {
    await expectRefused(h, () => governedChangeFixtureCommand(args, h.deps), text);
    expect(h.events).toEqual(["exit 1"]);
  }

  it("--agent naming a default config directory (an injected throwaway, never ~/.motebit)", async () => {
    const fx = await fixtureRepo(env, tmp);
    const h = harness({ defaultConfigDirs: () => [env.agentDir] });
    await refusedBeforeKey(h, fixtureArgs(env, fx, "b3"), /default motebit config directory/);
  });

  /** A config directory: A's config with the given identity fields replaced. */
  async function agentDirWith(fields: Record<string, string>): Promise<string> {
    const dir = fs.mkdtempSync(path.join(tmp, "agent-"));
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ ...(await agentConfigOf(env.a)), ...fields }),
    );
    return dir;
  }

  it("--agent's device_public_key not in its one spelling", async () => {
    const fx = await fixtureRepo(env, tmp);
    const dir = await agentDirWith({ device_public_key: env.a.pin.public_key.toUpperCase() });
    await refusedBeforeKey(
      harness(),
      fixtureArgs({ ...env, agentDir: dir }, fx, "b3"),
      /device_public_key is not in its one spelling/,
    );
  });

  it.each([
    ["scope", /scope\.json is not a repo-task scope of the strict shape/],
    ["grant", /grant\.json is not a grant of the strict shape/],
    ["tick", /tick\.json is not a tick of the strict shape/],
  ])("%s.json with an extra key is not of the strict shape", async (name, text) => {
    const fx = await fixtureRepo(env, tmp);
    const file = path.join(fx.delegation, `${name}.json`);
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify({ ...value, extra: 1 }));
    await refusedBeforeKey(harness(), fixtureArgs(env, fx, "b3"), text);
  });

  it("the scope's first allowed path is not a regular file at the tip", async () => {
    const fx = await fixtureRepo(env, tmp, { docSymlink: true });
    await refusedBeforeKey(
      harness(),
      fixtureArgs(env, fx, "b3"),
      /notes\/guide\.md is not a regular file at the tip/,
    );
  });

  it.each([
    ["the principal's motebit_id with A's key", "f", "a"],
    ["A's motebit_id with the principal's key", "a", "f"],
  ])("--agent is the principal by one half: %s", async (_name, id, key) => {
    const fx = await fixtureRepo(env, tmp);
    const pick = (w: string) => (w === "f" ? env.f : env.a);
    const dir = await agentDirWith({
      motebit_id: pick(id).pin.motebit_id,
      device_public_key: pick(key).pin.public_key,
    });
    await refusedBeforeKey(
      harness(),
      fixtureArgs({ ...env, agentDir: dir }, fx, "b3"),
      /--agent is the principal/,
    );
  });

  it.each([
    ["A's motebit_id with another key", true],
    ["another motebit_id with A's key", false],
  ])("--agent matches an agent pin by one half only: %s", async (_name, keepId) => {
    const fx = await fixtureRepo(env, tmp);
    const x = await party();
    const dir = await agentDirWith(
      keepId ? { device_public_key: x.pin.public_key } : { motebit_id: x.pin.motebit_id },
    );
    await refusedBeforeKey(
      harness(),
      fixtureArgs({ ...env, agentDir: dir }, fx, "b3"),
      /--agent is not an agent pin at the tip/,
    );
  });

  it("b5b: a grant revoked but never landed is not b5b's", async () => {
    const fx = await fixtureRepo(env, tmp, { revoked: true });
    await refusedBeforeKey(harness(), fixtureArgs(env, fx, "b5b"), /records as spent/);
  });

  it("b5b: a grant both landed and revoked is a second defect", async () => {
    const fx = await fixtureRepo(env, tmp, { landed: true, revoked: true });
    await refusedBeforeKey(
      harness(),
      fixtureArgs(env, fx, "b5b"),
      /records as spent[\s\S]*revocation\.repo_change\.revoked/,
    );
  });

  it("b4: the tick does not grant the scripted read", async () => {
    const fx = await fixtureRepo(env, tmp, { tools: "repo_write_path" });
    const h = harness();
    await expectRefused(
      h,
      () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b4"), h.deps),
      /--case b4: the tick does not grant repo_read_blob/,
    );
    expect(h.events).toEqual(["ephemeral", "erase", "exit 1"]);
  });

  it("b4: a scripted call that does not complete", async () => {
    const fx = await fixtureRepo(env, tmp, { omitDoc: true });
    const h = harness();
    await expectRefused(
      h,
      () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b4"), h.deps),
      /--case b4: the scripted repo_read_blob did not complete \(denied\)/,
    );
    expect(h.events).toEqual(["ephemeral", "erase", "exit 1"]);
  });

  it("a dirty worktree", async () => {
    const fx = await fixtureRepo(env, tmp);
    fs.writeFileSync(path.join(fx.repo, "src/code.ts"), "export const x = 2;\n");
    await refusedBeforeKey(
      harness(),
      fixtureArgs(env, fx, "b3"),
      /the worktree is not clean at the tip/,
    );
  });

  it("--agent is the principal", async () => {
    const fx = await fixtureRepo(env, tmp, { agentPins: [env.a, env.f] });
    const asF = fs.mkdtempSync(path.join(tmp, "as-f-"));
    fs.writeFileSync(
      path.join(asF, "config.json"),
      JSON.stringify({
        ...(await agentConfigOf(env.a)),
        motebit_id: env.f.pin.motebit_id,
        device_public_key: env.f.pin.public_key,
      }),
    );
    const args = fixtureArgs({ ...env, agentDir: asF }, fx, "b3");
    await refusedBeforeKey(harness(), args, /--agent is the principal/);
  });

  it("--agent is not an agent pin at the tip", async () => {
    const x = await party();
    const fx = await fixtureRepo(env, tmp, { agentPins: [x] });
    await refusedBeforeKey(
      harness(),
      fixtureArgs(env, fx, "b3"),
      /--agent is not an agent pin at the tip/,
    );
  });

  it("b5b: the landed bundle is not a regular 100644 file", async () => {
    const fx = await fixtureRepo(env, tmp, { landedExecutable: true });
    await refusedBeforeKey(
      harness(),
      fixtureArgs(env, fx, "b5b"),
      /is not a regular file at the tip/,
    );
  });

  it("b3: the out-of-scope path is in allowed_paths", async () => {
    const fx = await fixtureRepo(env, tmp, { allowedPaths: [DOC, OUTSIDE] });
    await refusedBeforeKey(harness(), fixtureArgs(env, fx, "b3"), /is in allowed_paths/);
  });

  it("b3: the out-of-scope path fails the tip's path policy", async () => {
    const fx = await fixtureRepo(env, tmp, { exclude: [OUTSIDE] });
    await refusedBeforeKey(harness(), fixtureArgs(env, fx, "b3"), /fails the tip's path policy/);
  });

  it("b3: the out-of-scope path is tracked at the tip", async () => {
    const fx = await fixtureRepo(env, tmp, { files: { [OUTSIDE]: "tracked\n" } });
    await refusedBeforeKey(harness(), fixtureArgs(env, fx, "b3"), /is tracked at the tip/);
  });

  it("the decrypted key is not the config's device_public_key: refused, the key erased", async () => {
    const fx = await fixtureRepo(env, tmp);
    const other = await party();
    const h = harness({ unlocked: (k) => ({ ...k, publicKey: other.pin.public_key }) });
    await expectRefused(
      h,
      () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b3"), h.deps),
      /the decrypted key is not the config's device_public_key/,
    );
    expect(h.events).toEqual(["unlock", "erase", "exit 1"]);
    expect(h.erased).toEqual([h.loaded[0]]);
    expect(zeroed(h.loaded[0]!)).toBe(true);
  });

  it("the scripted run did not make its edit: refused, the key erased", async () => {
    const fx = await fixtureRepo(env, tmp);
    // Inside the window for the preflight, the run's start and its key probe;
    // past it from the first tool call, so the run ends authority_lapsed.
    let n = 0;
    const h = harness({ now: () => (n++ < 3 ? NOW : NOW + 2 * HOUR) });
    await expectRefused(
      h,
      () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b5a"), h.deps),
      /the scripted run did not make its edit \(ended authority_lapsed/,
    );
    expect(h.events).toEqual(["unlock", "erase", "exit 1"]);
    expect(zeroed(h.loaded[0]!)).toBe(true);
  });
});

// -- b5a's respelling and b5b's bundle commit, directly -----------------------------------

describe("governed-change fixture: b5a's respelling and b5b's bundle commit", LONG, () => {
  it("a canonical 64-byte signature has a second, non-canonical spelling of the same bytes", async () => {
    const sig = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64url");
    const respelled = respellBase64Url(sig);
    expect(respelled).not.toBeNull();
    expect(respelled).not.toBe(sig);
    expect(Buffer.from(respelled!, "base64url")).toEqual(Buffer.from(sig, "base64url"));
    const { isCanonicalBase64Url } =
      await fromCli<typeof import("@motebit/verifier")>("@motebit/verifier");
    expect(isCanonicalBase64Url(sig)).toBe(true);
    expect(isCanonicalBase64Url(respelled!)).toBe(false);
  });

  it("a spelling with no unused bits has no second spelling", () => {
    expect(respellBase64Url("AAAA")).toBeNull();
  });

  it("a spelling whose unused bit is already set is not re-spelled to itself", () => {
    expect(respellBase64Url("AAB")).toBeNull();
  });

  const commit = {
    message: "bundle\n",
    authorName: "t",
    authorEmail: "t@example.com",
    timestamp: 1_800_000_000,
  };
  async function session(fx: FixtureRepo) {
    const { openIsolatedGit } = await verifyGit();
    return openIsolatedGit({ gitEntry: path.join(fx.repo, ".git"), objectFormat: "sha1" });
  }

  it("modifies the landed bundle: exactly one M of the bundle path", async () => {
    const fx = await fixtureRepo(env, tmp, { landed: true });
    const target = `.motebit/bundles/${fx.grantId}.json`;
    const g = await session(fx);
    try {
      const out = await commitBundleOverLanded(
        g,
        fx.tip,
        target,
        new TextEncoder().encode("{}"),
        commit,
      );
      expect(
        git(env.home, fx.repo, "diff-tree", "-r", "--no-commit-id", "--name-status", fx.tip, out),
      ).toBe(`M\t${target}`);
    } finally {
      g.close();
    }
  });

  it("refuses the landed bytes again (no change: not exactly one modify)", async () => {
    const fx = await fixtureRepo(env, tmp, { landed: true });
    const target = `.motebit/bundles/${fx.grantId}.json`;
    const same = gitBytes(env.home, fx.repo, "cat-file", "blob", `${fx.tip}:${target}`);
    const g = await session(fx);
    try {
      await expect(
        commitBundleOverLanded(g, fx.tip, target, new Uint8Array(same), commit),
      ).rejects.toThrow(/would not be exactly one modify of the landed bundle/);
    } finally {
      g.close();
    }
  });

  it("refuses a landed bundle that is not a 100644 file", async () => {
    const fx = await fixtureRepo(env, tmp, { landedExecutable: true });
    const target = `.motebit/bundles/${fx.grantId}.json`;
    const g = await session(fx);
    try {
      await expect(
        commitBundleOverLanded(g, fx.tip, target, new TextEncoder().encode("{}\n"), commit),
      ).rejects.toThrow(/is not a regular file at the change commit/);
    } finally {
      g.close();
    }
  });
});

// -- Time and the recorded runtime -----------------------------------------------------

describe(
  "governed-change fixture: the tick must outlast CI, and the run records the CLI's version",
  LONG,
  () => {
    async function expiresAt(fx: FixtureRepo): Promise<number> {
      const tick = JSON.parse(fs.readFileSync(path.join(fx.delegation, "tick.json"), "utf8")) as {
        expires_at: number;
      };
      return tick.expires_at;
    }

    it("exactly the margin left at the self-check: the push command, with the expiry", async () => {
      const fx = await fixtureRepo(env, tmp);
      const at = (await expiresAt(fx)) - TICK_MARGIN_MS;
      const h = harness({ now: () => at });
      await governedChangeFixtureCommand(fixtureArgs(env, fx, "b3"), h.deps);
      const out = h.lines.join("\n");
      expect(out).toContain(
        `CI must judge before ${new Date(at + TICK_MARGIN_MS).toISOString()}, when the tick expires`,
      );
      expect(out).toMatch(/git push <publisher-remote>/);
    });

    it("less than the margin left: refused, no push command", async () => {
      const fx = await fixtureRepo(env, tmp);
      const at = (await expiresAt(fx)) - TICK_MARGIN_MS + 1;
      const h = harness({ now: () => at });
      await expectRefused(
        h,
        () => governedChangeFixtureCommand(fixtureArgs(env, fx, "b3"), h.deps),
        /less than the 30 minutes CI needs/,
      );
    });

    it("the runtime version is the CLI package's, as a real run records it", async () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "..", "apps", "cli", "package.json"), "utf8"),
      ) as { version: string };
      expect(cliRuntimeVersion()).toBe(`motebit ${pkg.version}`);
      expect(cliRuntimeVersion()).not.toBe("motebit 0.0.0-dev");
      expect((await nodeFixtureDeps()).runtimeVersion).toBe(`motebit ${pkg.version}`);
    });
  },
);
