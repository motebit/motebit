#!/usr/bin/env node
// Tamper check for governed-change-landed-workflow.test.ts: the offline
// half of acceptance test B1, .github/workflows/governed-change-landed.yml,
// and the landed mode of its report script (scripts/governed-change-report.ts).
//
// Each entry reverts (part of) one rule — the dispatch-only trigger, the
// token's permissions, the checkout (main's tip, full history, no
// credentials), an action pin, the dependency cache, the no-expression-in-run
// rule, the guard step's ref and input checks, the judge container's
// isolation (no network, no capabilities, no_new_privs, read-only root and
// clone, non-root user, no host namespace or daemon socket, the built image
// from the pinned digest), the step's exit code and summary rules, the
// no-network proof that precedes the verifier, the landed mode's provenance
// self-check, its VERIFIED rule and exit codes, or the summary's fencing —
// and names the test expected to go red. The shared runner
// (scripts/lib/tamper-runner.ts) applies each tamper in an isolated copy of
// the tree.
//
//   node scripts/__tests__/governed-change-landed.tampers.mjs

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../lib/tamper-runner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = ".github/workflows/governed-change-landed.yml";
const REPORT = "scripts/governed-change-report.ts";
const TEST = "scripts/__tests__/governed-change-landed-workflow.test.ts";

const EXACT =
  "the governed-change-landed workflow's exact shape (the authority) equals the expected shape exactly: every key, every step, every value";
const TRIG = (t) => `the governed-change-landed workflow's trigger ${t}`;
const SAFE = (t) => `the governed-change-landed workflow's safety ${t}`;
const GUARD = (t) =>
  `the guard step refuses a dispatch off main and a landed commit that is not 40 lowercase hex ${t}`;
const BOX = (t) =>
  `the judge container: no network, no capabilities, non-root, read-only clone ${t}`;
const EXIT = (t) => `the judge step's exit code and summary ${t}`;
const PROOF = (t) => `the no-network proof ${t}`;
const SUMMARY = (t) => `governed-change-report landed: the summary ${t}`;
const E2E = (t) => `governed-change-report landed end to end ${t}`;
const FIRST = (t) =>
  `governed-change-report landed end to end: the no-network proof precedes the verifier ${t}`;
const PROV = (t) =>
  `governed-change-report landed end to end: the provenance self-check ${t} is NOT JUDGED (exit 1), the verifier never run`;

const TRIGGER = TRIG(
  "triggers on workflow_dispatch only, with one required string input landed_commit",
);
const PERMS = SAFE("has a read-only token: contents read, nothing else, no job override");
const CHECKOUT_ONE = SAFE(
  "checks out exactly one tree, this repository, full history, without persisting credentials",
);
const TIP_REF = SAFE(
  "the checkout and TRUSTED_TIP are main's tip on main and no revision on any other ref",
);
const NO_EXPR = SAFE("interpolates no expression into a run script (inputs reach it only by env)");
const PINS = SAFE(
  "every action is pinned to a full commit sha, the same pin autonomy-tier.yml uses",
);
const BAD_COMMIT = GUARD("refuses every landed commit that is not exactly 40 lowercase hex digits");
const ARGV = BOX("passes docker exactly the expected argv");
const NO_NET = BOX(
  "has no network: --network none, and no host namespace, device or daemon socket",
);
const NO_CAPS = BOX(
  "has no capabilities and no_new_privs: --cap-drop ALL, nothing added back, never privileged",
);
const NON_ROOT = BOX("runs as the runner's own non-root uid and gid");
const READ_ONLY = BOX(
  "the root filesystem and the clone are read-only; only /tmp (noexec) and the fresh output directory are writable",
);
const VARS = BOX("gets only the named variables, and the summary path inside the output directory");
const IMAGE_RUN = BOX(
  "runs the image this job built, never a pulled one, and the report script's landed mode",
);
const IMAGE_BUILD = BOX(
  "the image is built from the digest services/relay/Dockerfile pins, adds only git, with no build context",
);
const EXIT_CODE = EXIT(
  "the step's exit code is the container's, and the container's summary is appended",
);
const NO_SUMMARY = EXIT("a container that writes no summary never passes");
const FRESH = EXIT(
  "the output directory must be fresh: a leftover one fails the step before docker runs",
);
const LAST = EXIT(
  "the judge is the last step, and the only step that runs the report script or the verifier",
);
const PROOF_FAILED = FIRST("a failed proof is NOT JUDGED (exit 1) and the verifier never runs");
const VERIFIED_E2E = E2E(
  "a landed change that verifies concludes VERIFIED (exit 0), the inputs and every axis in the summary",
);
const REVOKED = E2E(
  "a revoked change concludes NOT VERIFIED (exit 1), revocation revoked in the summary",
);
const FENCE = SUMMARY(
  "a repository-controlled value cannot close the fence or write a headline into the summary",
);
const OFF = (text) => text.replace(/^(\s*(?:\} else )?)if \(/, "$1if ((false as boolean) && ");
const wf = (name, from, to, red) => ({ name, file: WORKFLOW, from, to, red });
const rp = (name, from, to, red) => ({ name, file: REPORT, from, to, red });

const JUDGE_ENV_TIP =
  "          TRUSTED_TIP: ${{ github.ref == 'refs/heads/main' && github.sha || 'no-trusted-tip-off-main' }}\n";
const CHECKOUT_REF =
  "          ref: ${{ github.ref == 'refs/heads/main' && github.sha || 'no-trusted-tip-off-main' }}\n";
const DOCKER_RUN = "docker run --rm --pull never --network none --cap-drop ALL \\\n";
const SEC = "            --security-opt no-new-privileges --read-only \\\n";
const MOUNTS = '            -v "$PWD:/repo:ro" -v "$out:/out" -w /repo \\\n';
const LAST_LINE = "--github-keys .motebit/operator-keys/github.json || rc=$?\n";

const TAMPERS = [
  // ── Trigger ──
  wf(
    "workflow: also runs on push",
    "on:\n  workflow_dispatch:\n",
    "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n",
    TRIGGER,
  ),
  wf(
    "workflow: also runs on pull_request_target",
    "on:\n  workflow_dispatch:\n",
    "on:\n  pull_request_target:\n  workflow_dispatch:\n",
    TRIGGER,
  ),
  wf(
    "workflow: the input is optional",
    "        required: true\n",
    "        required: false\n",
    TRIGGER,
  ),
  wf(
    "workflow: a job-level if (a skipped job reports success)",
    "    runs-on: ubuntu-latest\n",
    "    runs-on: ubuntu-latest\n    if: github.ref == 'refs/heads/main'\n",
    TRIG("is one job, with no job-level if (a skipped job reports success)"),
  ),
  // ── Token and credentials ──
  wf("workflow: contents: write", "  contents: read\n", "  contents: write\n", PERMS),
  wf(
    "workflow: an extra permission (actions: write)",
    "  contents: read\n",
    "  contents: read\n  actions: write\n",
    PERMS,
  ),
  wf(
    "workflow: a job-level permissions override",
    "    timeout-minutes: 20\n",
    "    timeout-minutes: 20\n    permissions: write-all\n",
    PERMS,
  ),
  wf(
    "workflow: the token handed to the judge step",
    JUDGE_ENV_TIP,
    `${JUDGE_ENV_TIP}          GH_TOKEN: \${{ github.token }}\n`,
    SAFE("references no secrets and hands the token to no step"),
  ),
  wf(
    "workflow: the checkout persists credentials",
    "          persist-credentials: false\n",
    "          persist-credentials: true\n",
    CHECKOUT_ONE,
  ),
  wf(
    "workflow: a shallow checkout",
    "          fetch-depth: 0\n",
    "          fetch-depth: 1\n",
    CHECKOUT_ONE,
  ),
  // ── main's tip only ──
  wf(
    "workflow: the checkout takes github.sha on every ref (no fail-closed sentinel)",
    CHECKOUT_REF,
    "          ref: ${{ github.sha }}\n",
    TIP_REF,
  ),
  wf(
    "workflow: TRUSTED_TIP is github.sha on every ref",
    JUDGE_ENV_TIP,
    "          TRUSTED_TIP: ${{ github.sha }}\n",
    TIP_REF,
  ),
  // ── No expression in a run script ──
  wf(
    "workflow: the input interpolated into the judge's script",
    "-e LANDED_COMMIT -e TRUSTED_TIP",
    '-e LANDED_COMMIT="${{ inputs.landed_commit }}" -e TRUSTED_TIP',
    NO_EXPR,
  ),
  wf(
    "workflow: the input handed to the build step",
    "      - name: Build motebit-verify from the trusted tip\n        working-directory: trusted\n",
    "      - name: Build motebit-verify from the trusted tip\n        working-directory: trusted\n        env:\n          LANDED_COMMIT: ${{ inputs.landed_commit }}\n",
    SAFE("the landed commit reaches a step only as LANDED_COMMIT, in the guard and the judge"),
  ),
  wf(
    "workflow: the judge step tolerated to fail",
    "      - name: Judge the landed change with no network (motebit-verify repo-change --landed)\n",
    "      - name: Judge the landed change with no network (motebit-verify repo-change --landed)\n        continue-on-error: true\n",
    SAFE("no step is conditional or allowed to fail"),
  ),
  // ── Pins and cache ──
  wf(
    "workflow: an action pinned to a tag",
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "actions/checkout@v7",
    PINS,
  ),
  wf(
    "workflow: an action pinned to another sha than autonomy-tier's",
    "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
    "pnpm/action-setup@1111111111111111111111111111111111111111",
    PINS,
  ),
  wf(
    "workflow: the dependency cache is switched back on",
    "          package-manager-cache: false\n",
    "          package-manager-cache: false\n          cache: pnpm\n",
    SAFE("takes the package manager from the checkout and keeps the dependency cache off"),
  ),
  wf(
    "workflow: NODE_OPTIONS in the judge step's env",
    "          # main's tip at dispatch (the checkout's expression).\n",
    "          NODE_OPTIONS: --require ./preload.cjs\n          # main's tip at dispatch (the checkout's expression).\n",
    SAFE("sets no shell or shell start-up file anywhere"),
  ),
  // ── The guard step ──
  wf(
    "workflow: the guard's ref check removed",
    'if [ "$GITHUB_REF" != "refs/heads/main" ]; then',
    "if false; then",
    GUARD("refuses every ref other than refs/heads/main"),
  ),
  wf("workflow: the guard accepts uppercase hex", "*[!0-9a-f]*)", "*[!0-9a-fA-F]*)", BAD_COMMIT),
  wf(
    "workflow: the guard accepts a longer value",
    '"${#LANDED_COMMIT}" -ne 40',
    '"${#LANDED_COMMIT}" -lt 40',
    BAD_COMMIT,
  ),
  wf(
    "workflow: the guard moved after the checkout (no longer first)",
    "      - name: Refuse a dispatch off main",
    '      - name: Early\n        run: "true"\n\n      - name: Refuse a dispatch off main',
    GUARD("is the first step, before the checkout"),
  ),
  // ── The judge container ──
  wf(
    "workflow: the container gets the default bridge network",
    DOCKER_RUN,
    "docker run --rm --pull never --cap-drop ALL \\\n",
    NO_NET,
  ),
  wf("workflow: the container gets the host network", "--network none", "--network host", NO_NET),
  wf(
    "workflow: the docker socket mounted into the container",
    MOUNTS,
    '            -v "$PWD:/repo:ro" -v "$out:/out" -v /var/run/docker.sock:/var/run/docker.sock -w /repo \\\n',
    NO_NET,
  ),
  wf(
    "workflow: the host PID namespace (/proc/<pid>/root reaches host sockets)",
    SEC,
    "            --security-opt no-new-privileges --read-only --pid host \\\n",
    NO_NET,
  ),
  wf(
    "workflow: the host IPC namespace",
    SEC,
    "            --security-opt no-new-privileges --read-only --ipc host \\\n",
    NO_NET,
  ),
  wf(
    "workflow: capabilities kept",
    DOCKER_RUN,
    "docker run --rm --pull never --network none \\\n",
    NO_CAPS,
  ),
  wf(
    "workflow: a capability added back",
    SEC,
    "            --security-opt no-new-privileges --read-only --cap-add NET_ADMIN \\\n",
    NO_CAPS,
  ),
  wf(
    "workflow: a privileged container",
    SEC,
    "            --security-opt no-new-privileges --read-only --privileged \\\n",
    NO_CAPS,
  ),
  wf("workflow: no_new_privs dropped", SEC, "            --read-only \\\n", NO_CAPS),
  wf(
    "workflow: a writable root filesystem",
    SEC,
    "            --security-opt no-new-privileges \\\n",
    READ_ONLY,
  ),
  wf("workflow: the clone mounted read-write", '-v "$PWD:/repo:ro"', '-v "$PWD:/repo"', READ_ONLY),
  wf(
    "workflow: an executable /tmp",
    "--tmpfs /tmp:rw,nosuid,nodev,noexec",
    "--tmpfs /tmp:rw,nosuid,nodev",
    READ_ONLY,
  ),
  wf(
    "workflow: the container runs as root",
    '--user "$(id -u):$(id -g)"',
    '--user "0:0"',
    NON_ROOT,
  ),
  wf(
    "workflow: the container runs as the image's default user",
    '            --user "$(id -u):$(id -g)" \\\n',
    "",
    NON_ROOT,
  ),
  wf(
    "workflow: the whole host environment passed in",
    "            -e HOME=/tmp -e GITHUB_STEP_SUMMARY=/out/summary.md \\\n",
    "            -e HOME=/tmp -e GITHUB_STEP_SUMMARY=/out/summary.md -e RUNNER_TEMP -e ACTIONS_RUNTIME_TOKEN \\\n",
    VARS,
  ),
  wf("workflow: the image may be pulled", "--pull never", "--pull missing", IMAGE_RUN),
  wf(
    "workflow: the container's command is not the landed report",
    "node --import tsx scripts/governed-change-report.ts landed",
    "node --import tsx scripts/governed-change-report.ts",
    IMAGE_RUN,
  ),
  wf(
    "workflow: the judge's repository is the dispatching repository, not motebit/motebit",
    "--repository motebit/motebit --repo /repo",
    '--repository "$GITHUB_REPOSITORY" --repo /repo',
    ARGV,
  ),
  wf(
    "workflow: the image built from a tag, not the pinned digest",
    "FROM node:22-slim@sha256:d415caac2f1f77b98caaf9415c5f807e14bc8d7bdea62561ea2fef4fbd08a73c\n",
    "FROM node:22-slim\n",
    IMAGE_BUILD,
  ),
  wf(
    "workflow: the image build gets a build context",
    '--iidfile "$RUNNER_TEMP/governed-change-landed.iid" - <<',
    '--iidfile "$RUNNER_TEMP/governed-change-landed.iid" -f - . <<',
    IMAGE_BUILD,
  ),
  // ── Exit code and summary ──
  wf(
    "workflow: the container's exit code swallowed",
    LAST_LINE,
    LAST_LINE.replace("|| rc=$?", "|| true"),
    EXIT_CODE,
  ),
  wf(
    "workflow: the step always exits 0",
    '          exit "$rc"\n',
    "          exit 0\n",
    EXIT_CODE,
  ),
  wf(
    "workflow: a missing summary passes",
    '          elif [ "$rc" -eq 0 ]; then\n            echo "the judge wrote no summary" >&2\n            rc=1\n',
    '          elif [ "$rc" -eq 0 ]; then\n            echo "the judge wrote no summary" >&2\n',
    NO_SUMMARY,
  ),
  wf("workflow: a leftover output directory reused", 'mkdir "$out"', 'mkdir -p "$out"', FRESH),
  wf(
    "workflow: a step after the judge",
    '          exit "$rc"\n',
    '          exit "$rc"\n\n      - name: After\n        run: "true"\n',
    LAST,
  ),
  wf(
    "workflow: the report script run outside the container too",
    'run: pnpm --filter "@motebit/verify..." run build\n',
    'run: pnpm --filter "@motebit/verify..." run build && pnpm exec tsx scripts/governed-change-report.ts landed\n',
    LAST,
  ),
  wf("workflow: the timeout raised", "timeout-minutes: 20", "timeout-minutes: 360", EXACT),

  // ── The no-network proof ──
  rp(
    "report: the proof skipped",
    "  const offline = await proveNoNetwork(opts.network ?? REAL_PROBES);",
    "  const offline: string[] = [];",
    PROOF_FAILED,
  ),
  rp(
    "report: a failed proof does not stop the verifier",
    "  if (offline.length > 0) {",
    OFF("  if (offline.length > 0) {"),
    PROOF_FAILED,
  ),
  rp(
    "report: a non-loopback interface accepted",
    "      .filter(([, addrs]) => (addrs ?? []).some((a) => !a.internal))",
    "      .filter(([, addrs]) => (addrs ?? []).some((a) => !a.internal && false))",
    PROOF("a network interface other than loopback fails the proof"),
  ),
  rp(
    "report: unreadable interfaces accepted",
    "    problems.push(\n      `the network interfaces are unreadable:",
    "    ([] as string[]).push(\n      `the network interfaces are unreadable:",
    PROOF("unreadable network interfaces fail the proof"),
  ),
  rp(
    "report: a name that resolves accepted",
    '  if (name.kind === "ok") problems.push',
    '  if ((false as boolean) && name.kind === "ok") problems.push',
    PROOF("a name that resolves fails the proof"),
  ),
  rp(
    "report: a lookup that times out accepted",
    '  if (name.kind === "timeout") problems.push',
    '  if ((false as boolean) && name.kind === "timeout") problems.push',
    PROOF("a lookup that never settles fails the proof (a timeout is not proof)"),
  ),
  rp(
    "report: a connect that is made accepted",
    '  if (tcp.kind === "ok")',
    '  if ((false as boolean) && tcp.kind === "ok")',
    PROOF("a connect that is made fails the proof"),
  ),
  rp(
    "report: a connect that times out accepted",
    '  if (tcp.kind === "timeout") {',
    OFF('  if (tcp.kind === "timeout") {'),
    PROOF("a connect that never settles fails the proof (a timeout is not proof)"),
  ),
  rp(
    "report: any connect error counts as no route",
    "    if (!NO_ROUTE_CODES.has(code)) {",
    OFF("    if (!NO_ROUTE_CODES.has(code)) {"),
    PROOF("a connect refused, timed out or failing with no code is not proof of no route"),
  ),
  rp(
    "report: ECONNREFUSED counts as no route",
    'new Set(["ENETUNREACH", "EHOSTUNREACH"])',
    'new Set(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED"])',
    PROOF(
      "probes github.com and 1.1.1.1:443, and only ENETUNREACH / EHOSTUNREACH count as no route",
    ),
  ),

  // ── The report script's landed mode: VERIFIED and exit codes ──
  rp(
    "report: landed exit 0 not required for VERIFIED",
    "      const verified = report.accepted === true && run.status === 0;",
    "      const verified = report.accepted === true;",
    E2E("a verifier that reports accepted: true but exits 1 is not VERIFIED"),
  ),
  rp(
    "report: landed accepted: true not required for VERIFIED",
    "      const verified = report.accepted === true && run.status === 0;",
    "      const verified = run.status === 0;",
    E2E("a verifier that exits 0 without accepted: true is not VERIFIED"),
  ),
  rp(
    "report: landed NOT VERIFIED exits 0",
    "      return verified ? 0 : 1;",
    "      return 0;",
    REVOKED,
  ),
  rp(
    "report: landed NOT VERIFIED headlined VERIFIED",
    '      const conclusion = verified ? "verified" : "not-verified";',
    '      const conclusion = "verified";',
    REVOKED,
  ),
  rp(
    "report: landed NOT JUDGED exits 0",
    "trustedTip, reason, stderr }));\n  return 1;\n}",
    "trustedTip, reason, stderr }));\n  return 0;\n}",
    E2E(
      "the verifier unable to judge (its exit 2) concludes NOT JUDGED (exit 1), its error in the summary",
    ),
  ),
  rp(
    "report: the landed subcommand not dispatched",
    "  if (argv[0] === LANDED_SUBCOMMAND) return mainLanded(argv.slice(1), opts);\n",
    "\n",
    VERIFIED_E2E,
  ),
  // ── The landed mode's provenance self-check ──
  rp(
    "report: the event check removed",
    "  if (env.GITHUB_EVENT_NAME !== LANDED_EVENT) problems.push",
    "  if ((false as boolean) && env.GITHUB_EVENT_NAME !== LANDED_EVENT) problems.push",
    PROV("an event other than workflow_dispatch"),
  ),
  rp(
    "report: the ref check removed",
    "  if (env.GITHUB_REF !== LANDED_REF) problems.push",
    "  if ((false as boolean) && env.GITHUB_REF !== LANDED_REF) problems.push",
    PROV("a ref other than refs/heads/main"),
  ),
  rp(
    "report: the landed commit's case not checked",
    "export const LANDED_COMMIT_ID = /^[0-9a-f]{40}$/;",
    "export const LANDED_COMMIT_ID = /^[0-9a-f]{40}$/i;",
    PROV("an uppercase landed commit"),
  ),
  rp(
    "report: the landed commit's end not anchored",
    "export const LANDED_COMMIT_ID = /^[0-9a-f]{40}$/;",
    "export const LANDED_COMMIT_ID = /^[0-9a-f]{40}/;",
    PROV("a landed commit with a trailing newline"),
  ),
  rp(
    "report: the landed commit not checked at all",
    "  if (landed === null) {",
    OFF("  if (landed === null) {"),
    PROV("a short landed commit"),
  ),
  rp(
    "report: the TRUSTED_TIP check removed",
    "    if (env.TRUSTED_TIP !== trustedTip) problems.push",
    "    if ((false as boolean) && env.TRUSTED_TIP !== trustedTip) problems.push",
    PROV("a checkout that is not TRUSTED_TIP"),
  ),
  rp(
    "report: the GITHUB_SHA check removed",
    "    if (env.GITHUB_SHA !== trustedTip) problems.push",
    "    if ((false as boolean) && env.GITHUB_SHA !== trustedTip) problems.push",
    PROV("a checkout that is not GITHUB_SHA"),
  ),
  rp(
    "report: judges another event than the workflow's",
    'export const LANDED_EVENT = "workflow_dispatch";',
    'export const LANDED_EVENT = "push";',
    TRIG("the report script judges exactly the workflow's event, from main"),
  ),
  // ── The summary ──
  rp(
    "report: a repository value shown outside the fence",
    "    lines.push(`| time problem | ${token(r.report.timeProblem)} |`);",
    "    lines.push(`| time problem | ${String(r.report.timeProblem)} |`);",
    FENCE,
  ),
];

// Run as a command with a red marker; `-t`, anchored to the exact full name,
// narrows each run to the one test that must go red.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

await runTampers(
  TAMPERS.map((t) => ({
    name: t.name,
    command: ["pnpm", "exec", "vitest", "run", TEST, "-t", `^${escapeRegExp(t.red)}$`],
    redMarker: "Test Files  1 failed",
    edits: t.edits ?? [{ file: t.file, from: t.from, to: t.to }],
  })),
  { root: ROOT },
);
