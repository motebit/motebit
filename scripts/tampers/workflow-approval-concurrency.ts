/**
 * Tamper checks for the approval-vs-unattended concurrency rule
 * (scripts/__tests__/workflow-approval-concurrency.test.ts).
 *
 * Each entry puts back one way a job waiting on the `production` reviewer
 * could hold a concurrency group the scheduled staging probe needs, and names
 * the test that must go red.
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
/** The prod-presence job takes the staging job's group. */
const SHARED_GROUP = edit(
  "      group: archetype-conformance-prod-presence\n",
  "      group: archetype-conformance-staging\n",
);

const TAMPERS: TamperEntry[] = [
  entry(
    "the workflow-level group is restored (pin)",
    `${PIN} has no workflow-level concurrency group`,
    WORKFLOW_GROUP,
  ),
  entry(
    "the workflow-level group is restored (class rule over every workflow)",
    `${CLASS} no workflow under .github/workflows breaks the rule`,
    WORKFLOW_GROUP,
  ),
  entry(
    "prod-presence shares the staging job's group (pin)",
    `${PIN} the scheduled staging job's group is shared with no job behind environment: production`,
    SHARED_GROUP,
  ),
  entry(
    "prod-presence shares the staging job's group (class rule over every workflow)",
    `${CLASS} no workflow under .github/workflows breaks the rule`,
    SHARED_GROUP,
  ),
  entry(
    "the staging job loses its own group",
    `${PIN} every job has its own group, and no two jobs share one`,
    edit(
      "    concurrency:\n      group: archetype-conformance-staging\n      cancel-in-progress: false\n",
      "",
    ),
  ),
  entry(
    "a queued staging probe cancels the running one",
    `${PIN} neither job cancels a running probe`,
    edit(
      "      group: archetype-conformance-staging\n      cancel-in-progress: false\n",
      "      group: archetype-conformance-staging\n      cancel-in-progress: true\n",
    ),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
