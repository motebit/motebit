/**
 * ci.yml least-privilege tamper checks — each rule check-prepush-subset gained
 * for the GITHUB_TOKEN grant and the turbo remote-cache secrets, removed, must
 * turn `scripts/__tests__/check-prepush-subset.test.ts` ("least privilege: …")
 * red.
 *
 * Every entry is (edits — text the fix added and what to put back, in one or
 * more files; the vitest name filter that must go red). The runner applies one
 * tamper at a time, runs the test file, expects a FAILURE, and restores. An
 * entry whose text is not found is a failure of this script (never a silent
 * green).
 *
 *   npx tsx scripts/tampers/ci-least-privilege.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = "scripts/check-prepush-subset.ts";
const CI = ".github/workflows/ci.yml";
const TEST = "scripts/__tests__/check-prepush-subset.test.ts";
const FILTER = "least privilege|KP1";

interface Edit {
  file: string;
  find: string;
  replace: string;
}
interface Tamper {
  name: string;
  edits: Edit[];
}

const ALLOW = "(github.event_name == 'push' || github.event_name == 'merge_group')";

const TAMPERS: Tamper[] = [
  {
    name: "the top-level permissions pin is not checked (P1–P5 green)",
    edits: [
      {
        file: GATE,
        find: "  if (JSON.stringify(wf.permissions ?? null) !== JSON.stringify(WORKFLOW_PERMISSIONS)) {\n",
        replace: "  if (false) {\n",
      },
    ],
  },
  {
    name: "a job-level permissions is not refused (P6, P7 green)",
    edits: [
      {
        file: GATE,
        find: '      if (lower === "permissions")\n',
        replace: "      if (false)\n",
      },
    ],
  },
  {
    name: "the expression allowlist is not applied (P11–P17, P20–P23 green)",
    edits: [
      {
        file: GATE,
        find: "  violations.push(...ciExpressionViolations(wf));\n",
        replace: "\n",
      },
    ],
  },
  {
    name: "the allowlist accepts any reference (unknown context paths pass)",
    edits: [
      {
        file: GATE,
        find: "      if (CI_EXPRESSION_ALLOWLIST[ref] === undefined)\n",
        replace: "      if (false)\n",
      },
    ],
  },
  {
    name: "matching is case-sensitive (control KP1 `GITHUB.EVENT_NAME`, the same context as an allowlisted path, goes false-RED)",
    edits: [
      {
        file: GATE,
        find: '    const path = m[1]?.replace(/\\s+/g, "").toLowerCase();\n',
        replace: '    const path = m[1]?.replace(/\\s+/g, "");\n',
      },
    ],
  },
  {
    name: "a bare if: is not read as an expression (P21 green)",
    edits: [
      {
        file: GATE,
        find: "    if (isIf && exprs.length === 0) judge(s, where);\n",
        replace: "",
      },
    ],
  },
  {
    name: "an unparseable expression is skipped instead of RED (P16 green)",
    edits: [
      {
        file: GATE,
        find: '    if ("error" in r) {\n      out.push(\n',
        replace: '    if ("error" in r) {\n      return;\n      out.push(\n',
      },
    ],
  },
  {
    name: "a job-level uses: / secrets: is not refused (P18, P19 green)",
    edits: [
      {
        file: GATE,
        find: "      if ((CI_FORBIDDEN_JOB_KEYS as readonly string[]).includes(lower))\n",
        replace: "      if (false)\n",
      },
    ],
  },
  {
    name: "a bare if: is recognised only by the exact key `if` (P30 green)",
    edits: [
      {
        file: GATE,
        find: 'text(v, where, key.toLowerCase() === "if")',
        replace: 'text(v, where, key === "if")',
      },
    ],
  },
  {
    name: "keys are not read as expressions (P24 green)",
    edits: [
      {
        file: GATE,
        find: "        text(k, `${at} (key)`, false);\n",
        replace: "",
      },
    ],
  },
  {
    name: "a YAML merge key is not refused (P25, P26 green)",
    edits: [
      {
        file: GATE,
        find: '        if (k === "<<")\n',
        replace: "        if (false)\n",
      },
    ],
  },
  {
    name: "job keys are compared case-sensitively (P27–P29 green)",
    edits: [
      {
        file: GATE,
        find: "      const lower = k.toLowerCase();\n",
        replace: "      const lower = k;\n",
      },
    ],
  },
  {
    name: "ci.yml loses its permissions block and the gate stops pinning it",
    edits: [
      {
        file: CI,
        find: "permissions:\n  contents: read\n",
        replace: "",
      },
      {
        file: GATE,
        find: "  if (JSON.stringify(wf.permissions ?? null) !== JSON.stringify(WORKFLOW_PERMISSIONS)) {\n",
        replace: "  if (false) {\n",
      },
    ],
  },
  {
    name: "the turbo secrets reach every event again, in ci.yml and in the pin",
    edits: [
      {
        file: CI,
        find: `  TURBO_TOKEN: \${{ ${ALLOW} && secrets.TURBO_TOKEN || '' }}\n`,
        replace: "  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}\n",
      },
      {
        file: CI,
        find: `  TURBO_REMOTE_CACHE_SIGNATURE_KEY: \${{ ${ALLOW} && secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY || '' }}\n`,
        replace:
          "  TURBO_REMOTE_CACHE_SIGNATURE_KEY: ${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}\n",
      },
      {
        file: GATE,
        find: `    "\${{ ${ALLOW} && secrets.TURBO_TOKEN || '' }}",\n`,
        replace: '    "${{ secrets.TURBO_TOKEN }}",\n',
      },
      {
        file: GATE,
        find: `    "\${{ ${ALLOW} && secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY || '' }}",\n`,
        replace: '    "${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",\n',
      },
    ],
  },
  {
    name: "the event allowlist inverted to a pull_request denylist, in ci.yml and in the pin",
    edits: [
      {
        file: CI,
        find: `  TURBO_TOKEN: \${{ ${ALLOW} && secrets.TURBO_TOKEN || '' }}\n`,
        replace:
          "  TURBO_TOKEN: ${{ github.event_name != 'pull_request' && secrets.TURBO_TOKEN || '' }}\n",
      },
      {
        file: GATE,
        find: `    "\${{ ${ALLOW} && secrets.TURBO_TOKEN || '' }}",\n`,
        replace: `    "\${{ github.event_name != 'pull_request' && secrets.TURBO_TOKEN || '' }}",\n`,
      },
    ],
  },
];

function passes(): boolean {
  try {
    execFileSync("npx", ["vitest", "run", TEST, "-t", FILTER], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
for (const t of TAMPERS) {
  const originals = new Map<string, string>();
  for (const e of t.edits) {
    const abs = path.join(ROOT, e.file);
    if (!originals.has(abs)) originals.set(abs, readFileSync(abs, "utf8"));
  }
  const stale = t.edits.find(
    (e) => !readFileSync(path.join(ROOT, e.file), "utf8").includes(e.find),
  );
  if (stale !== undefined) {
    console.error(`STALE  ${t.name}: text not found in ${stale.file}`);
    failures++;
    continue;
  }
  try {
    for (const e of t.edits) {
      const abs = path.join(ROOT, e.file);
      writeFileSync(abs, readFileSync(abs, "utf8").replace(e.find, e.replace));
    }
    if (passes()) {
      console.error(`GREEN  ${t.name}: ${TEST} still passes with the rule removed`);
      failures++;
    } else {
      console.log(`red    ${t.name}`);
    }
  } finally {
    for (const [abs, text] of originals) writeFileSync(abs, text);
  }
}
if (failures > 0) {
  console.error(`${failures} tamper(s) did not turn the test red`);
  process.exit(1);
}
if (!passes()) {
  console.error(`${TEST} is red with every tamper restored`);
  process.exit(1);
}
console.log(`all ${TAMPERS.length} tampers turned the test red; restored tree green`);
