/**
 * `motebit-verify repo-change` — judge a governed repo change's pull request
 * in CI-on-PR mode (spec/repo-change-v1.md §7, §9):
 *
 * ```
 *   motebit-verify repo-change --repo <clone> --base <trusted tip commit>
 *     --head <pr head commit> --repository <owner/name> --base-ref <ref name>
 *     --pr-author <login> [--now <ms>] [--json]
 * ```
 *
 * Wiring only (CLAUDE.md rule 1): the inputs come from `@motebit/verify/git`
 * (`computeRepoChangeInputs`, through the isolated git session — git never
 * runs on the clone's own git directory and nothing is fetched; CI has
 * already fetched both commits), and the judgment is `@motebit/verifier`'s
 * `verifyRepoChange`. The evaluation time is the local clock unless `--now`
 * is given, recorded as `local_clock`.
 *
 * Exit codes: 0 fully verified with outcome `completed`; 1 any other verdict;
 * 2 a usage or I/O error, or a change that cannot be judged (no parsable path
 * policy at the base, a shallow clone).
 */
import { verifyRepoChangePullRequest } from "./git/repo-change.js";
import type { RepoChangeReport } from "./git/repo-change.js";

/** The first positional that switches the CLI into repo-change mode. */
export const REPO_CHANGE_SUBCOMMAND = "repo-change";

export interface RepoChangeArgs {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly prAuthor: string;
  readonly now?: number;
  readonly json: boolean;
}

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
} as const;
type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

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
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (key !== "now" && values[key] === undefined) {
      return { kind: "usage", message: `repo-change: missing ${flag}` };
    }
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
];
