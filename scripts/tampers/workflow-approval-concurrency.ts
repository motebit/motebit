/**
 * Tamper checks for the approval-vs-unattended concurrency rule
 * (scripts/__tests__/workflow-approval-concurrency.test.ts).
 *
 * Each entry puts back one way a job waiting on the `production` reviewer
 * could hold a concurrency group the scheduled staging probe needs (or drops
 * the staging job's own serialization), and names the test that must go red.
 *
 *   node scripts/tampers/workflow-approval-concurrency.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const WORKFLOW = ".github/workflows/archetype-conformance.yml";
const TEST = "scripts/__tests__/workflow-approval-concurrency.test.ts";

const PIN = "archetype-conformance.yml: approval never blocks the scheduled staging probe";
const CLASS =
  "class rule: a job behind environment: production shares no concurrency group with unattended work";

const edit = (from: string, to: string): TamperEdit => ({ file: WORKFLOW, from, to });
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  test: TEST,
  red,
  edits,
});

/** The 2026-11-14 defect: one workflow-level group over both jobs. */
const WORKFLOW_GROUP = edit(
  "\npermissions:\n  contents: read\n\njobs:\n",
  "\nconcurrency:\n  group: archetype-conformance\n  cancel-in-progress: false\n\npermissions:\n  contents: read\n\njobs:\n",
);
/** Where a job-level group on prod-presence would go. */
const PROD_ENV = "    timeout-minutes: 10\n    environment: production\n";
const prodGroup = (group: string): TamperEdit =>
  edit(
    PROD_ENV,
    `${PROD_ENV}    concurrency:\n      group: ${group}\n      cancel-in-progress: false\n`,
  );
/** The prod-presence job takes the staging job's group. */
const SHARED_GROUP = prodGroup("archetype-conformance-staging");

const NO_PROD_GROUP = `${PIN} no job behind environment: production declares a concurrency group`;
const ALL_WORKFLOWS = `${CLASS} no workflow under .github/workflows breaks the rule`;

const TAMPERS: TamperEntry[] = [
  entry(
    "the workflow-level group is restored (pin)",
    `${PIN} has no workflow-level concurrency group`,
    WORKFLOW_GROUP,
  ),
  entry(
    "the workflow-level group is restored (class rule over every workflow)",
    ALL_WORKFLOWS,
    WORKFLOW_GROUP,
  ),
  entry("prod-presence gains the staging group (pin)", NO_PROD_GROUP, SHARED_GROUP),
  entry(
    "prod-presence gains the staging group (pin: staging group shared with no production job)",
    `${PIN} the scheduled staging job's group is shared with no job behind environment: production`,
    SHARED_GROUP,
  ),
  entry(
    "prod-presence gains the staging group (class rule over every workflow)",
    ALL_WORKFLOWS,
    SHARED_GROUP,
  ),
  entry(
    "prod-presence gains any group, even its own",
    NO_PROD_GROUP,
    prodGroup("archetype-conformance-prod-presence"),
  ),
  entry(
    "the environment name is compared case-sensitively (Production hides a gated job)",
    `${CLASS} the environment name is compared case-insensitively, in both forms`,
    { file: TEST, from: "  return n.toLowerCase();\n", to: "  return n;\n" },
  ),
  entry(
    "shorthand group names are compared case-sensitively (concurrency: g vs G)",
    `${CLASS} group names are compared case-insensitively: (b) in one workflow, (c) across workflows`,
    {
      file: TEST,
      from: '  if (typeof node === "string") return node.toLowerCase();\n',
      to: '  if (typeof node === "string") return node;\n',
    },
  ),
  entry(
    "object-form group names are compared case-sensitively (group: g vs G)",
    `${CLASS} group names are compared case-insensitively: (b) in one workflow, (c) across workflows`,
    { file: TEST, from: "  return g.toLowerCase();\n", to: "  return g;\n" },
  ),
  entry(
    "a caller hides its callee's unattended jobs (workflow-level group over a mixed callee)",
    `${CLASS} a caller carries the UNION of its callee's jobs: a mixed callee under a workflow-level group`,
    {
      file: TEST,
      from: "unattended: !own && (inner.some((k) => k.unattended) || !production)",
      to: "unattended: !production",
    },
  ),
  entry(
    "a caller hides its callee's unattended jobs (job-level group on the caller of a mixed callee)",
    `${CLASS} a caller carries the UNION of its callee's jobs: a mixed callee under the caller's job-level group`,
    {
      file: TEST,
      from: "unattended: !own && (inner.some((k) => k.unattended) || !production)",
      to: "unattended: !production",
    },
  ),
  entry(
    "an environment built from an expression reads as not-production instead of failing closed",
    `${CLASS} fails closed, naming the file and job, on an environment built from an expression`,
    {
      file: TEST,
      from: '  if (n.includes("${{")) {\n    throw',
      to: '  if ((false as boolean) && n.includes("${{")) {\n    throw',
    },
  ),
  entry(
    "a reusable workflow in another repository reads as not-production instead of failing closed",
    `${CLASS} fails closed on a reusable workflow it cannot read (another repository, or a missing file)`,
    {
      file: TEST,
      from: "    if (!m) {\n      throw",
      to: "    if (!m) return { production: own, unattended: !own };\n    if (!m) {\n      throw",
    },
  ),
  entry(
    "the staging job loses its group",
    `${PIN} the scheduled staging job has the staging group and is not behind production`,
    edit(
      "    concurrency:\n      group: archetype-conformance-staging\n      cancel-in-progress: false\n",
      "",
    ),
  ),
  entry(
    "a queued staging probe cancels the running one",
    `${PIN} a running staging probe is never cancelled`,
    edit(
      "      group: archetype-conformance-staging\n      cancel-in-progress: false\n",
      "      group: archetype-conformance-staging\n      cancel-in-progress: true\n",
    ),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
