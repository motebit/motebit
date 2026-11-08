#!/usr/bin/env node
// Tamper check for governed-change-workflow.test.ts: the expand state of
// .github/workflows/governed-change.yml and its report script
// (scripts/governed-change-report.ts).
//
// Each entry reverts (part of) one rule — a trigger, the token's permissions,
// the trusted-only checkout, the bare fsck-checked fetch, an action pin, the
// dependency cache, the no-expression-in-run rule, the provenance self-check,
// which pull requests are judged, the exit code of each conclusion, or the
// summary's fencing of PR-controlled text — and names the test expected to go
// red. The shared runner (scripts/lib/tamper-runner.ts) applies each tamper in
// an isolated copy of the tree.
//
//   node scripts/__tests__/governed-change.tampers.mjs

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../lib/tamper-runner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = ".github/workflows/governed-change.yml";
const REPORT = "scripts/governed-change-report.ts";
const TEST = "scripts/__tests__/governed-change-workflow.test.ts";

const EXACT =
  "the governed-change workflow's exact shape (the authority) equals the expected shape exactly: every key, every step, every value";
const TRIG = (t) => `the governed-change workflow's triggers (expand) ${t}`;
const SAFE = (t) => `the governed-change workflow's pull_request_target safety ${t}`;
const PURE = (t) => `governed-change-report: the pure core ${t}`;
const GOV = (t) => `governed-change-report end to end: a governed change ${t}`;
const WHICH = (t) => `governed-change-report end to end: which pull requests are judged ${t}`;
const HAZ = (t) => `governed-change-report end to end: the committer landing hazard ${t}`;
const HAZ_BODY = HAZ(
  "a governed PR with the word in the body reports the hazard and fails (exit 1), the verdict still VERIFIED",
);
const PROV = (t) =>
  `governed-change-report end to end: the provenance self-check ${t} is NOT JUDGED (exit 1), the verifier never run`;

const TRIGGERS = TRIG("triggers on pull_request_target into main only, for every PR-side change");
const PERMS = SAFE(
  "has a read-only token: contents and pull-requests read, nothing else, no job override",
);
const CHECKOUT_ONE = SAFE(
  "checks out exactly one tree, the base tip, without persisting credentials",
);
const CHECKOUT_REF = SAFE(
  "the checkout is the base tip on pull_request_target and no revision on any other event, never the PR head",
);
const NO_EXPR = SAFE(
  "interpolates no expression into a run script (event fields reach it only by env and file)",
);
const FETCHED = SAFE(
  "the change is fetched as git objects into a bare store, fsck-checked, from this repository, never the fork",
);
const PINS = SAFE(
  "every action is pinned to a full commit sha, the same pin autonomy-tier.yml uses",
);
const ORDINARY = WHICH(
  "an ordinary PR (nothing under .motebit/bundles/) is not judged: exit 0, never reported verified",
);
const POLICY_REF =
  "ref: ${{ github.event_name == 'pull_request_target' && github.sha || 'no-policy-revision-for-this-event' }}";
const OFF = (text) => text.replace(/^(\s*(?:\} else )?)if \(/, "$1if ((false as boolean) && ");
const wf = (name, from, to, red) => ({ name, file: WORKFLOW, from, to, red });
const rp = (name, from, to, red) => ({ name, file: REPORT, from, to, red });

const TAMPERS = [
  // ── Triggers ──
  wf(
    "workflow: runs on merge_group",
    "    types: [opened, edited, synchronize, reopened, ready_for_review]\n",
    "    types: [opened, edited, synchronize, reopened, ready_for_review]\n  merge_group:\n    types: [checks_requested]\n",
    TRIG("does not run on merge_group (that mode is the contract phase's)"),
  ),
  wf(
    "workflow: also runs on pull_request (the PR's own copy of the file)",
    "on:\n  pull_request_target:\n",
    "on:\n  pull_request:\n    branches: [main]\n  pull_request_target:\n",
    TRIGGERS,
  ),
  wf(
    "workflow: a PR-side change no longer re-runs it (types narrowed)",
    "[opened, edited, synchronize, reopened, ready_for_review]",
    "[opened, synchronize]",
    TRIGGERS,
  ),
  wf(
    "workflow: a base other than main",
    "    branches: [main]\n",
    '    branches: [main, "release/**"]\n',
    TRIGGERS,
  ),
  wf(
    "workflow: a job-level if (a skipped job reports success)",
    "    runs-on: ubuntu-latest\n",
    "    runs-on: ubuntu-latest\n    if: github.event.pull_request.user.login == 'motebit-agent'\n",
    TRIG("is one job named governed-change, with no job-level if (a skipped job reports success)"),
  ),
  // ── Token and credentials ──
  wf("workflow: contents: write", "  contents: read\n", "  contents: write\n", PERMS),
  wf(
    "workflow: an extra permission (checks: write)",
    "  pull-requests: read\n",
    "  pull-requests: read\n  checks: write\n",
    PERMS,
  ),
  wf(
    "workflow: a job-level permissions override",
    "    timeout-minutes: 15\n",
    "    timeout-minutes: 15\n    permissions: write-all\n",
    PERMS,
  ),
  wf(
    "workflow: the token handed to the judge step",
    "          EVENT_HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n        run: >-\n          pnpm exec tsx",
    "          EVENT_HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n          GH_TOKEN: ${{ github.token }}\n        run: >-\n          pnpm exec tsx",
    SAFE("references no secrets and hands the token to no step"),
  ),
  wf(
    "workflow: the checkout persists credentials",
    "          persist-credentials: false\n",
    "          persist-credentials: true\n",
    CHECKOUT_ONE,
  ),
  // ── Never PR code ──
  wf(
    "workflow: the checkout takes the PR head",
    POLICY_REF,
    "ref: ${{ github.event.pull_request.head.sha }}",
    CHECKOUT_REF,
  ),
  wf(
    "workflow: the checkout takes github.sha on every event (no fail-closed sentinel)",
    POLICY_REF,
    "ref: ${{ github.sha }}",
    CHECKOUT_REF,
  ),
  wf(
    "workflow: a second checkout, of the PR head",
    "      - uses: pnpm/action-setup@",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          path: pr\n          persist-credentials: false\n\n      - uses: pnpm/action-setup@",
    CHECKOUT_ONE,
  ),
  wf(
    "workflow: a run step outside trusted/",
    "      - name: Install the base tip's dependencies (uncached)\n        working-directory: trusted\n",
    "      - name: Install the base tip's dependencies (uncached)\n",
    SAFE("every run step works in trusted/, never in the PR head"),
  ),
  wf(
    "workflow: an expression interpolated into the fetch script",
    '"+$EVENT_HEAD_SHA:refs/governed-change/head"',
    '"+${{ github.event.pull_request.head.sha }}:refs/governed-change/head"',
    NO_EXPR,
  ),
  wf(
    "workflow: the judge step tolerated to fail",
    "      - name: Judge the change (motebit-verify repo-change, CI-on-PR mode)\n",
    "      - name: Judge the change (motebit-verify repo-change, CI-on-PR mode)\n        continue-on-error: true\n",
    SAFE("no step is conditional or allowed to fail"),
  ),
  wf(
    "workflow: NODE_OPTIONS in the judge step's env",
    "          # The base tip the checkout was told to take (same expression).\n",
    "          NODE_OPTIONS: --require ./preload.cjs\n          # The base tip the checkout was told to take (same expression).\n",
    SAFE("sets no shell or shell start-up file anywhere"),
  ),
  // ── The fetch ──
  wf("workflow: the fetch without fsck", " -c fetch.fsckObjects=true\n", "\n", FETCHED),
  wf(
    "workflow: the store has a working tree",
    "git init --quiet --bare",
    "git init --quiet",
    FETCHED,
  ),
  {
    name: "workflow: the change fetched from the fork",
    edits: [
      {
        file: WORKFLOW,
        from: '          "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"\n',
        to: '          "$HEAD_REPO_URL"\n',
      },
      {
        file: WORKFLOW,
        from: "          POLICY_SHA: ${{",
        to: "          HEAD_REPO_URL: ${{ github.event.pull_request.head.repo.clone_url }}\n          POLICY_SHA: ${{",
      },
    ],
    red: FETCHED,
  },
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
    SAFE("takes the package manager from the base and keeps the dependency cache off"),
  ),
  // ── What only the exact shape catches ──
  wf(
    "workflow: the judge's exit code swallowed (|| true)",
    '--subject "$GITHUB_WORKSPACE/subject.git"\n',
    '--subject "$GITHUB_WORKSPACE/subject.git" || true\n',
    EXACT,
  ),
  wf("workflow: the timeout raised", "timeout-minutes: 15", "timeout-minutes: 360", EXACT),

  // ── The report script: which pull requests are judged ──
  rp(
    "report: an ordinary PR is judged (the not-governed short-circuit removed)",
    "  if (!isGovernedChange(subject, base, head)) {",
    OFF("  if (!isGovernedChange(subject, base, head)) {"),
    ORDINARY,
  ),
  rp(
    "report: an ordinary PR is headlined VERIFIED",
    '"not-governed": "not a governed change (not judged)",',
    '"not-governed": "VERIFIED",',
    ORDINARY,
  ),
  rp(
    "report: case folding dropped",
    "  const p = asciiLower(path);",
    "  const p = Buffer.from(path);",
    WHICH("a PR adding a case variant of .motebit/bundles/ is judged"),
  ),
  rp(
    "report: compared from the base tip, not the merge base",
    "    mergeBase,\n    head,\n  ]);",
    "    base,\n    head,\n  ]);",
    WHICH(
      "an ordinary PR branched before a bundle landed on main is not judged (compared from the merge base)",
    ),
  ),
  rp(
    "report: deletions under .motebit/bundles/ ignored",
    '    "--name-only",\n',
    '    "--name-only",\n    "--diff-filter=AM",\n',
    WHICH("a PR that deletes a bundle on main is judged"),
  ),
  rp(
    "report: no merge base reads as not governed",
    "  } catch {\n    return true;\n  }",
    "  } catch {\n    return false;\n  }",
    WHICH("a PR with no merge base is judged"),
  ),
  rp(
    "report: BUNDLES_DIR drifts from the verifier's",
    'export const BUNDLES_DIR = ".motebit/bundles/";',
    'export const BUNDLES_DIR = ".motebit/bundle/";',
    PURE("BUNDLES_DIR is the verifier's"),
  ),
  rp(
    "report: judges another event than the workflow's",
    'export const JUDGED_EVENT = "pull_request_target";',
    'export const JUDGED_EVENT = "pull_request";',
    TRIG("the report script judges exactly the workflow's one event, in the expand phase"),
  ),
  // ── The provenance self-check ──
  rp(
    "report: the event-name check removed",
    "  if (env.GITHUB_EVENT_NAME !== JUDGED_EVENT) {",
    OFF("  if (env.GITHUB_EVENT_NAME !== JUDGED_EVENT) {"),
    PROV("an event other than pull_request_target"),
  ),
  rp(
    "report: the GITHUB_SHA check removed",
    '    if (env.GITHUB_SHA !== policySha) problems.push("the trusted checkout is not GITHUB_SHA");',
    '    if ((false as boolean) && env.GITHUB_SHA !== policySha) problems.push("the trusted checkout is not GITHUB_SHA");',
    PROV("a checkout that is not GITHUB_SHA"),
  ),
  rp(
    "report: the EXPECTED_POLICY_SHA check removed",
    "    if (env.EXPECTED_POLICY_SHA !== policySha) {",
    OFF("    if (env.EXPECTED_POLICY_SHA !== policySha) {"),
    PROV("a checkout that is not EXPECTED_POLICY_SHA"),
  ),
  rp(
    "report: the EVENT_HEAD_SHA check removed",
    "  } else if (env.EVENT_HEAD_SHA !== headSha) {",
    "  } else if ((false as boolean) && env.EVENT_HEAD_SHA !== headSha) {",
    PROV("a fetched head that is not the payload's"),
  ),
  // ── Exit codes ──
  rp(
    "report: a verifier exit 0 is accepted without accepted: true",
    "      const accepted = run.status === 0 && report.accepted === true;",
    "      const accepted = run.status === 0;",
    GOV("a verifier that exits 0 without accepted: true is not VERIFIED"),
  ),
  rp(
    "report: NOT VERIFIED exits 0",
    "      return accepted && hazards.length === 0 ? 0 : 1;",
    "      return 0;",
    GOV("that is revoked concludes NOT VERIFIED (exit 1), revocation revoked in the summary"),
  ),
  rp(
    "report: NOT JUDGED exits 0",
    "      hazards,\n    }),\n  );\n  return 1;\n}",
    "      hazards,\n    }),\n  );\n  return 0;\n}",
    GOV(
      "the verifier unable to judge (its exit 2) concludes NOT JUDGED (exit 1), its error in the summary",
    ),
  ),
  // ── The committer landing hazard ──
  rp(
    "report: the body is not checked for the word",
    '  if (has(body)) fields.push("body");',
    OFF('  if (has(body)) fields.push("body");'),
    HAZ_BODY,
  ),
  rp(
    "report: the title is not checked for the word",
    '  if (has(title)) fields.push("title");',
    OFF('  if (has(title)) fields.push("title");'),
    HAZ("a governed PR with the word in the title reports the hazard and fails (exit 1)"),
  ),
  rp(
    "report: the word matched case-sensitively",
    '    typeof v === "string" && asciiLowerString(v).includes(COMMITTER_HAZARD_WORD);',
    '    typeof v === "string" && v.includes(COMMITTER_HAZARD_WORD);',
    HAZ("the word is matched in any case (Committer) and fails (exit 1)"),
  ),
  rp(
    "report: a near-miss (commit) flagged",
    'export const COMMITTER_HAZARD_WORD = "committer";',
    'export const COMMITTER_HAZARD_WORD = "commit";',
    HAZ(
      "without the word (a near-miss such as commit included) there is no hazard: VERIFIED, exit 0",
    ),
  ),
  rp(
    "report: a hazard does not fail a VERIFIED run",
    "      return accepted && hazards.length === 0 ? 0 : 1;",
    "      return accepted ? 0 : 1;",
    HAZ_BODY,
  ),
  rp(
    "report: the hazard not written to the summary",
    "  if (r.hazards !== undefined && r.hazards.length > 0) lines.push(...renderHazards(r.hazards));",
    "",
    HAZ_BODY,
  ),
  rp(
    "report: a NOT JUDGED change drops the hazard",
    "      stderr,\n      hazards,\n    }),\n  );\n  return 1;\n}",
    "      stderr,\n    }),\n  );\n  return 1;\n}",
    HAZ("a NOT JUDGED governed change still reports the hazard"),
  ),
  rp(
    "report: a non-governed PR is flagged",
    '    write(renderSummary({ conclusion: "not-governed", number, policySha: base, headSha: head }));\n    return 0;',
    '    write(renderSummary({ conclusion: "not-governed", number, policySha: base, headSha: head, hazards: landingHazards(pr?.title, pr?.body) }));\n    return landingHazards(pr?.title, pr?.body).length > 0 ? 1 : 0;',
    HAZ("a non-governed PR containing the word is not flagged: exit 0"),
  ),
  rp(
    "report: landingHazards ignores the body (pure core)",
    '  if (has(body)) fields.push("body");',
    "",
    "governed-change-report: the committer landing hazard (pure core) landingHazards names the field carrying the word, ASCII case folded, and nothing else",
  ),
  // ── The summary ──
  rp(
    "report: a fixed fence a PR value can close",
    'const fence = "`".repeat(Math.max(3, longest + 1));',
    'const fence = "`".repeat(3 + 0 * longest);',
    PURE("a PR-controlled value cannot close the fence or write a headline into the summary"),
  ),
  rp(
    "report: any string shown outside the fence",
    'return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(v)',
    'return typeof v === "string"',
    PURE("a PR-controlled value cannot close the fence or write a headline into the summary"),
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
