#!/usr/bin/env node
// Tamper check for governed-change-landed-workflow.test.ts: the offline
// half of acceptance test B1, .github/workflows/governed-change-landed.yml,
// and the landed mode of its report script (scripts/governed-change-report.ts).
//
// Each entry reverts (part of) one rule — the dispatch-only trigger, the
// token's permissions, the checkout (main's tip, full history, no
// credentials), an action pin, the dependency cache, the no-expression-in-run
// rule, the guard step's ref and input checks, the network namespace and the
// proof that it has no network, which step runs the verifier, the landed
// mode's provenance self-check, its VERIFIED rule and exit codes, or the
// summary's fencing — and names the test expected to go red. The shared
// runner (scripts/lib/tamper-runner.ts) applies each tamper in an isolated
// copy of the tree.
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
const NET = (t) => `the network is cut before the verifier runs, and the cut is proven ${t}`;
const SUMMARY = (t) => `governed-change-report landed: the summary ${t}`;
const E2E = (t) => `governed-change-report landed end to end ${t}`;
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
const WRAPS = NET(
  "the judge step is the last step, after the control, and wraps everything in new network and mount namespaces",
);
const PRELUDE = NET(
  "as root, before the drop, loopback comes up and a fresh tmpfs masks /run (and /var/run when it is not a symlink)",
);
const DROP = NET("the drop clears supplementary groups (no docker group) and sets no_new_privs");
const SUCCEEDS = NET(
  "a request that succeeds inside the namespace fails the step and the verifier never runs",
);
const OTHER_FAILURE = NET(
  "any other curl failure (a timeout, an HTTP or TLS error) is not proof of no network",
);
const NAME_RESOLVED = NET(
  "a name that resolved (curl exit 7 for github.com) is not proof of no network",
);
const GETENT = NET(
  "a name getent resolves, or any getent result but not-found, is not proof of no resolver",
);
const NO_GETENT = NET("a missing getent is not proof of no resolver");
const SOCKET = (s) =>
  NET(`${s} present inside the namespace fails the step and the verifier never runs`);
const RUNS = NET(
  "the verifier runs when every probe holds (name 6; address 6 or 7; getent 2; no socket)",
);
const SOCKETS_LINE =
  "for sock in /run/systemd/resolve/io.systemd.Resolve /run/dbus/system_bus_socket /var/run/docker.sock; do";
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
    '      LANDED_COMMIT="$LANDED_COMMIT" TRUSTED_TIP="$TRUSTED_TIP" \\\n',
    '      LANDED_COMMIT="${{ inputs.landed_commit }}" TRUSTED_TIP="$TRUSTED_TIP" \\\n',
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
  // ── The network cut and its proof ──
  wf(
    "workflow: no namespaces (the judge runs on the host's network and filesystem)",
    "sudo -- unshare --net --mount --propagation private -- sh -c '\n",
    "sudo -- sh -c '\n",
    WRAPS,
  ),
  wf(
    "workflow: no mount namespace (the tmpfs would cover the host's /run)",
    "unshare --net --mount --propagation private --",
    "unshare --net --",
    WRAPS,
  ),
  wf(
    "workflow: shared mount propagation (a mount could leak to the host)",
    "--mount --propagation private -- sh",
    "--mount --propagation shared -- sh",
    WRAPS,
  ),
  wf(
    "workflow: /run not masked (resolver, bus and docker sockets reachable)",
    "            mount -t tmpfs -o nosuid,nodev,noexec,mode=0755 tmpfs /run\n",
    "",
    PRELUDE,
  ),
  wf(
    "workflow: /var/run not masked when it is a directory",
    "            if [ ! -L /var/run ]; then mount -t tmpfs -o nosuid,nodev,noexec,mode=0755 tmpfs /var/run; fi\n",
    "",
    PRELUDE,
  ),
  wf(
    "workflow: a failed mount ignored (no set -e in the root prelude)",
    "            set -e\n",
    "",
    PRELUDE,
  ),
  wf(
    "workflow: supplementary groups restored (--init-groups: the docker group reaches docker.sock)",
    "--clear-groups",
    "--init-groups",
    DROP,
  ),
  wf(
    "workflow: no_new_privs dropped (the judge could sudo out of the namespace)",
    " --clear-groups --no-new-privs -- \\\n",
    " --clear-groups -- \\\n",
    DROP,
  ),
  wf(
    "workflow: a step after the judge",
    "--github-keys .motebit/operator-keys/github.json\n            '\n",
    '--github-keys .motebit/operator-keys/github.json\n            \'\n\n      - name: After\n        run: "true"\n',
    WRAPS,
  ),
  wf(
    "workflow: the name probe accepts curl exit 7 (the name resolved)",
    'if [ "$rc" -ne 6 ]; then',
    'if [ "$rc" -ne 6 ] && [ "$rc" -ne 7 ]; then',
    NAME_RESOLVED,
  ),
  wf(
    "workflow: the name probe's result not checked",
    'if [ "$rc" -ne 6 ]; then',
    "if false; then",
    SUCCEEDS,
  ),
  wf(
    "workflow: the name probe's curl exit not the one checked",
    "https://github.com || rc=$?",
    "https://github.com || rc=6",
    OTHER_FAILURE,
  ),
  wf("workflow: any address-probe exit counts as no network", "6|7) ;;", "*) ;;", SUCCEEDS),
  wf(
    "workflow: a timeout or TLS error on the address probe counts as no network",
    "6|7) ;;",
    "6|7|28|35) ;;",
    OTHER_FAILURE,
  ),
  wf(
    "workflow: the getent probe's result not checked",
    'if [ "$rc" -ne 2 ]; then',
    "if false; then",
    GETENT,
  ),
  wf(
    "workflow: a missing getent counts as no resolver",
    'if [ "$rc" -ne 2 ]; then',
    'if [ "$rc" -ne 2 ] && [ "$rc" -ne 127 ]; then',
    NO_GETENT,
  ),
  wf(
    "workflow: the resolver socket not probed",
    SOCKETS_LINE,
    SOCKETS_LINE.replace(" /run/systemd/resolve/io.systemd.Resolve", ""),
    SOCKET("/run/systemd/resolve/io.systemd.Resolve"),
  ),
  wf(
    "workflow: the system bus socket not probed",
    SOCKETS_LINE,
    SOCKETS_LINE.replace(" /run/dbus/system_bus_socket", ""),
    SOCKET("/run/dbus/system_bus_socket"),
  ),
  wf(
    "workflow: the docker socket not probed",
    SOCKETS_LINE,
    SOCKETS_LINE.replace(" /var/run/docker.sock", ""),
    SOCKET("/var/run/docker.sock"),
  ),
  wf(
    "workflow: the verifier runs before the probes",
    "            sh -c '\n              rc=0\n",
    '            sh -c \'\n              ./node_modules/.bin/tsx scripts/governed-change-report.ts landed --repository motebit/motebit --repo "$PWD" --github-keys .motebit/operator-keys/github.json\n              rc=0\n',
    SUCCEEDS,
  ),
  wf(
    "workflow: the judge's repository is the dispatching repository, not motebit/motebit",
    "--repository motebit/motebit --repo",
    '--repository "$GITHUB_REPOSITORY" --repo',
    RUNS,
  ),
  wf(
    "workflow: the control tolerated to fail",
    "curl -sS --max-time 10 -o /dev/null https://1.1.1.1\n\n",
    "curl -sS --max-time 10 -o /dev/null https://1.1.1.1 || true\n\n",
    NET("the control step makes the same requests outside the namespace and must succeed"),
  ),
  wf(
    "workflow: the report script run outside the namespace too",
    'run: pnpm --filter "@motebit/verify..." run build\n',
    'run: pnpm --filter "@motebit/verify..." run build && pnpm exec tsx scripts/governed-change-report.ts landed\n',
    NET("only the judge step runs the report script or the verifier"),
  ),
  // ── What only the exact shape catches ──
  wf(
    "workflow: the judge's exit code swallowed (|| true)",
    "--github-keys .motebit/operator-keys/github.json\n            '\n",
    "--github-keys .motebit/operator-keys/github.json\n            ' || true\n",
    EXACT,
  ),
  wf("workflow: the timeout raised", "timeout-minutes: 20", "timeout-minutes: 360", EXACT),

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
