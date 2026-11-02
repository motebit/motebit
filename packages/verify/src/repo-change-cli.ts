/**
 * `motebit-verify repo-change` — judge a governed repo change
 * (spec/repo-change-v1.md §7, §9), in one of two modes:
 *
 * ```
 *   # CI on a pull request.
 *   motebit-verify repo-change --repo <clone> --base <trusted tip commit>
 *     --head <pr head commit> --repository <owner/name> --base-ref <ref name>
 *     --pr-author <login> [--now <ms>] [--json]
 *
 *   # Offline, on a landed change.
 *   motebit-verify repo-change --landed <squash commit> --trusted-tip <commit>
 *     --repository <owner/name> --github-keys <file> --repo <clone> [--json]
 * ```
 *
 * The two are mutually exclusive: `--landed` selects the offline mode, which
 * takes `--trusted-tip` and `--github-keys` and refuses `--base`, `--head`,
 * `--base-ref`, `--pr-author` and `--now` (its evaluation time is the squash
 * commit's committer time, accepted only under the pinned keys); without
 * `--landed`, `--trusted-tip` and `--github-keys` are refused.
 *
 * Wiring only (CLAUDE.md rule 1): the inputs come from `@motebit/verify/git`
 * (`computeRepoChangeInputs` / `computeLandedRepoChangeInputs`, through the
 * isolated git session — git never runs on the clone's own git directory and
 * nothing is fetched), and the judgment is `@motebit/verifier`'s
 * `verifyRepoChange`.
 *
 * Exit codes: 0 fully verified with outcome `completed`; 1 any other verdict;
 * 2 a usage or I/O error, or a change that cannot be judged (no parsable path
 * policy, a shallow clone, an object store that does not hold or does not
 * hash to what it is asked for, a pinned-keys file that does not parse).
 */
import * as fs from "node:fs";

import { verifyRepoChangeLanded } from "./git/landed.js";
import type { LandedRepoChangeReport } from "./git/landed.js";
import { verifyRepoChangePullRequest } from "./git/repo-change.js";
import type { RepoChangeReport } from "./git/repo-change.js";

/** The first positional that switches the CLI into repo-change mode. */
export const REPO_CHANGE_SUBCOMMAND = "repo-change";

/** CI on a pull request. */
export interface RepoChangePullRequestArgs {
  readonly mode: "pull_request";
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly prAuthor: string;
  readonly now?: number;
  readonly json: boolean;
}

/** Offline, on a landed change. */
export interface RepoChangeLandedArgs {
  readonly mode: "landed";
  readonly repo: string;
  readonly landed: string;
  readonly trustedTip: string;
  readonly repository: string;
  /** Path of the pinned signing keys file (armored OpenPGP public key blocks). */
  readonly githubKeys: string;
  readonly json: boolean;
}

export type RepoChangeArgs = RepoChangePullRequestArgs | RepoChangeLandedArgs;

export type ParsedRepoChangeArgs =
  | { readonly kind: "run"; readonly args: RepoChangeArgs }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string };

const FLAGS = {
  "--repo": "repo",
  "--base": "base",
  "--head": "head",
  "--repository": "repository",
  "--base-ref": "baseRef",
  "--pr-author": "prAuthor",
  "--now": "now",
  "--landed": "landed",
  "--trusted-tip": "trustedTip",
  "--github-keys": "githubKeys",
} as const;
type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

/** Required in each mode, in the order a missing one is reported. */
const PR_REQUIRED = ["--repo", "--base", "--head", "--repository", "--base-ref", "--pr-author"];
const LANDED_REQUIRED = ["--landed", "--trusted-tip", "--repository", "--github-keys", "--repo"];
const PR_ONLY = ["--base", "--head", "--base-ref", "--pr-author", "--now"];
const LANDED_ONLY = ["--trusted-tip", "--github-keys"];

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Parse the arguments after `repo-change`. */
export function parseRepoChangeArgs(argv: readonly string[]): ParsedRepoChangeArgs {
  const values: Partial<Record<FlagKey, string>> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!Object.hasOwn(FLAGS, arg)) {
      return {
        kind: "usage",
        message: arg.startsWith("-")
          ? `repo-change: unknown flag: ${arg}`
          : `repo-change: unexpected argument: ${arg}`,
      };
    }
    const key = FLAGS[arg as keyof typeof FLAGS];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { kind: "usage", message: `repo-change: ${arg} requires a value` };
    }
    if (values[key] !== undefined) {
      return { kind: "usage", message: `repo-change: ${arg} given twice` };
    }
    values[key] = value;
    i++;
  }
  const has = (flag: string): boolean => values[FLAGS[flag as keyof typeof FLAGS]] !== undefined;

  if (has("--landed")) {
    for (const flag of PR_ONLY) {
      if (has(flag)) {
        return { kind: "usage", message: `repo-change: ${flag} is not used with --landed` };
      }
    }
    for (const flag of LANDED_REQUIRED) {
      if (!has(flag)) return { kind: "usage", message: `repo-change: missing ${flag}` };
    }
    const landed = values.landed!;
    const tip = values.trustedTip!;
    if (!OBJECT_ID.test(landed)) {
      return { kind: "usage", message: "repo-change: --landed must be a full lowercase commit id" };
    }
    if (!OBJECT_ID.test(tip) || tip.length !== landed.length) {
      return {
        kind: "usage",
        message:
          "repo-change: --trusted-tip must be a full lowercase commit id of --landed's object format",
      };
    }
    return {
      kind: "run",
      args: {
        mode: "landed",
        repo: values.repo!,
        landed,
        trustedTip: tip,
        repository: values.repository!,
        githubKeys: values.githubKeys!,
        json,
      },
    };
  }

  for (const flag of LANDED_ONLY) {
    if (has(flag)) return { kind: "usage", message: `repo-change: ${flag} requires --landed` };
  }
  for (const flag of PR_REQUIRED) {
    if (!has(flag)) return { kind: "usage", message: `repo-change: missing ${flag}` };
  }
  const base = values.base!;
  const head = values.head!;
  if (!OBJECT_ID.test(base)) {
    return { kind: "usage", message: "repo-change: --base must be a full lowercase commit id" };
  }
  if (!OBJECT_ID.test(head) || head.length !== base.length) {
    return {
      kind: "usage",
      message: "repo-change: --head must be a full lowercase commit id of --base's object format",
    };
  }
  let now: number | undefined;
  if (values.now !== undefined) {
    if (!/^(?:0|[1-9][0-9]{0,15})$/.test(values.now) || !Number.isSafeInteger(Number(values.now))) {
      return {
        kind: "usage",
        message: "repo-change: --now must be milliseconds since the epoch (a non-negative integer)",
      };
    }
    now = Number(values.now);
  }
  return {
    kind: "run",
    args: {
      mode: "pull_request",
      repo: values.repo!,
      base,
      head,
      repository: values.repository!,
      baseRef: values.baseRef!,
      prAuthor: values.prAuthor!,
      ...(now !== undefined ? { now } : {}),
      json,
    },
  };
}

/** Where the process writes: injected so the command is testable without a process. */
export interface RepoChangeIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly clock: () => number;
}

/** Any control character, shown escaped: a repository's file names never steer the terminal. */
export function printable(s: string): string {
  return s.replace(CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Run the command; resolves with the exit code. */
export async function runRepoChangeCli(args: RepoChangeArgs, io: RepoChangeIo): Promise<number> {
  if (args.mode === "landed") return runLanded(args, io);
  let report: RepoChangeReport;
  try {
    report = await verifyRepoChangePullRequest({
      repo: args.repo,
      base: args.base,
      head: args.head,
      repository: args.repository,
      baseRef: args.baseRef,
      prAuthor: args.prAuthor,
      now: args.now ?? io.clock(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`motebit-verify: repo-change: not judged: ${printable(msg)}\n`);
    return 2;
  }
  const { computed, verification: v, accepted, evaluatedAt } = report;
  if (args.json) {
    io.stdout(
      `${JSON.stringify(
        {
          accepted,
          verdict: v.verdict,
          outcome: v.outcome,
          diagnostics: v.diagnostics,
          evaluatedAt,
          temporalBasis: "local_clock",
          base: args.base,
          head: args.head,
          changeCommit: computed.changeCommit,
          bundlePath: computed.bundlePath,
          repository: args.repository,
          baseRef: args.baseRef,
          prAuthor: args.prAuthor,
          spent: computed.input.spent,
          shapeFailures: computed.shapeFailures,
          baseProblems: computed.state.problems,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const lines = [
      accepted
        ? "✓ repo-change VERIFIED — a completed governed change"
        : "✗ repo-change NOT VERIFIED",
      `  integrity ${v.verdict.integrity}, identityBinding ${v.verdict.identityBinding}, authority ${v.verdict.authority}, revocation ${v.verdict.revocation.status}; outcome ${v.outcome ?? "none"}`,
      `  base           ${args.base}`,
      `  head           ${args.head}`,
      `  change commit  ${computed.changeCommit ?? "none"}`,
      `  bundle         ${computed.bundlePath === null ? "none" : printable(computed.bundlePath)}`,
      `  evaluated at   ${evaluatedAt} (local_clock)`,
    ];
    if (v.diagnostics.failures.length > 0) {
      lines.push("  failures:");
      for (const f of v.diagnostics.failures) lines.push(`    ${f.code}: ${printable(f.detail)}`);
    }
    if (computed.state.problems.length > 0) {
      lines.push("  at the base (pins, policy):");
      for (const p of computed.state.problems) lines.push(`    ${printable(p)}`);
    }
    io.stdout(`${lines.join("\n")}\n`);
  }
  return accepted ? 0 : 1;
}

async function runLanded(args: RepoChangeLandedArgs, io: RepoChangeIo): Promise<number> {
  let report: LandedRepoChangeReport;
  try {
    const keys = fs.readFileSync(args.githubKeys, "utf8");
    report = await verifyRepoChangeLanded({
      repo: args.repo,
      landed: args.landed,
      trustedTip: args.trustedTip,
      repository: args.repository,
      signingKeys: keys,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`motebit-verify: repo-change: not judged: ${printable(msg)}\n`);
    return 2;
  }
  const { computed, verification: v, accepted } = report;
  const { time } = computed;
  if (args.json) {
    io.stdout(
      `${JSON.stringify(
        {
          accepted,
          verdict: v.verdict,
          outcome: v.outcome,
          diagnostics: v.diagnostics,
          evaluatedAt: time.landedAt,
          temporalBasis: "operator_recorded",
          timeProblem: time.problem,
          committer: time.committer,
          signer: time.signer,
          landed: args.landed,
          parent: computed.parent,
          trustedTip: args.trustedTip,
          bundlePath: computed.bundlePath,
          repository: args.repository,
          spent: computed.input.spent,
          shapeFailures: computed.shapeFailures,
          parentProblems: computed.state.problems,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const lines = [
      accepted
        ? "✓ repo-change VERIFIED — a completed governed change, landed"
        : "✗ repo-change NOT VERIFIED",
      `  integrity ${v.verdict.integrity}, identityBinding ${v.verdict.identityBinding}, authority ${v.verdict.authority}, revocation ${v.verdict.revocation.status}; outcome ${v.outcome ?? "none"}`,
      `  landed         ${args.landed}`,
      `  parent         ${computed.parent}`,
      `  trusted tip    ${args.trustedTip}`,
      `  bundle         ${computed.bundlePath === null ? "none" : printable(computed.bundlePath)}`,
      time.landedAt === null
        ? `  evaluated at   none (operator_recorded time not accepted: ${printable(time.problem ?? "")})`
        : `  evaluated at   ${time.landedAt} (operator_recorded, signed by ${time.signer ?? "?"})`,
    ];
    if (v.diagnostics.failures.length > 0) {
      lines.push("  failures:");
      for (const f of v.diagnostics.failures) lines.push(`    ${f.code}: ${printable(f.detail)}`);
    }
    if (computed.state.problems.length > 0) {
      lines.push("  at the parent (pins, policy):");
      for (const p of computed.state.problems) lines.push(`    ${printable(p)}`);
    }
    io.stdout(`${lines.join("\n")}\n`);
  }
  return accepted ? 0 : 1;
}

/** The repo-change section of `motebit-verify --help`. */
export const REPO_CHANGE_HELP: readonly string[] = [
  "  REPO-CHANGE MODE — `motebit-verify repo-change ...` (CI on a pull request)",
  "  --repo <clone>            The clone (a worktree or a bare repository). Git never",
  "                            runs on its own git directory; nothing is fetched.",
  "  --base <commit>           The trusted tip of main: pins, revocations, the path",
  "                            policy and spent are read here, never from the PR.",
  "  --head <commit>           The pull request's head (the bundle commit).",
  "  --repository <owner/name> The repository the check runs in.",
  "  --base-ref <ref>          The pull request's base ref (must be main).",
  "  --pr-author <login>       The pull request's author (must be motebit-agent).",
  "  --now <ms>                Evaluation time; default the local clock (local_clock).",
  "                            Exit 0 only when fully verified with outcome completed.",
  "",
  "  REPO-CHANGE OFFLINE — `motebit-verify repo-change --landed ...` (a landed change)",
  "  --landed <commit>         The squash commit that landed the change. Every commit",
  "                            and tree is read raw and re-hashed; the commit-graph,",
  "                            grafts and replace refs are never used.",
  "  --trusted-tip <commit>    A trusted tip of main (an independent witness); the",
  "                            squash commit must be on its first-parent chain.",
  "  --repository <owner/name> The repository; the scope's repo must equal it.",
  "  --github-keys <file>      The pinned signing keys: armored OpenPGP public key",
  "                            blocks (v4 RSA primary keys). The squash commit's",
  "                            committer time counts only when the committer is",
  "                            GitHub <noreply@github.com> and its signature verifies",
  "                            under one of them (operator_recorded); otherwise",
  "                            authority is unknown.",
  "  --repo <clone>            The clone. Pins, revocations, the path policy and spent",
  "                            are read at the squash commit's parent.",
  "                            Not with --base, --head, --base-ref, --pr-author, --now.",
];
