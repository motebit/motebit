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
  expectedVerdict,
  governedChangeFixtureCommand,
  judge,
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
