/**
 * The #997 round-2 mutation table — each row is a shape a cold review
 * reproduced PASSING the gate on a mutated copy of THIS repository (or a
 * sibling the law must also refuse). A row is applied to a fresh copy of the
 * real workflows, turbo.json, package.json and .husky/pre-push (a git repo,
 * so a committed `.turbo/` is observable), and the gate must turn RED on it.
 *
 * Not a test file: the table is shared by the law test and the
 * gate-mutation test (which disables one rule at a time and requires some row
 * to go green — every rule is load-bearing).
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMap, isSeq, parseDocument, type Document } from "yaml";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** A git copy of the repository files the gate reads. */
export function copyRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "turbo-law-")));
  for (const f of ["turbo.json", "package.json", ".gitignore"]) {
    cpSync(join(REPO_ROOT, f), join(d, f));
  }
  mkdirSync(join(d, ".husky"), { recursive: true });
  cpSync(join(REPO_ROOT, ".husky", "pre-push"), join(d, ".husky", "pre-push"));
  cpSync(join(REPO_ROOT, ".github", "workflows"), join(d, ".github", "workflows"), {
    recursive: true,
  });
  if (existsSync(join(REPO_ROOT, ".github", "actions"))) {
    cpSync(join(REPO_ROOT, ".github", "actions"), join(d, ".github", "actions"), {
      recursive: true,
    });
  }
  git(d, "init", "-q", ".");
  git(d, "add", "-A");
  git(d, "-c", "user.email=law@motebit.invalid", "-c", "user.name=law", "commit", "-qm", "copy");
  return d;
}

const wf = (root: string, file: string): string => join(root, ".github", "workflows", file);

/** Edit one workflow as a YAML document (comments and layout kept). */
export function editWorkflow(root: string, file: string, edit: (doc: Document) => void): void {
  const p = wf(root, file);
  const doc = parseDocument(readFileSync(p, "utf8"));
  edit(doc);
  writeFileSync(p, doc.toString({ lineWidth: 0 }));
}

/** Append a step to a job. */
function addStep(doc: Document, job: string, step: Record<string, unknown>, at?: number): void {
  const steps = doc.getIn(["jobs", job, "steps"]);
  if (!isSeq(steps)) throw new Error(`fixture: jobs.${job}.steps is not a sequence`);
  const node = doc.createNode(step);
  if (at == null) steps.items.push(node);
  else steps.items.splice(at, 0, node);
}

/** Index of the step whose `name` matches. */
function stepIndex(doc: Document, job: string, name: RegExp): number {
  const steps = doc.getIn(["jobs", job, "steps"]);
  if (!isSeq(steps)) throw new Error(`fixture: jobs.${job}.steps is not a sequence`);
  const i = steps.items.findIndex(
    (s) => isMap(s) && typeof s.get("name") === "string" && name.test(s.get("name") as string),
  );
  if (i < 0) throw new Error(`fixture: no step matching ${name} in jobs.${job}`);
  return i;
}

const WRITER_SECRETS = {
  TURBO_TOKEN: "${{ secrets.TURBO_WRITER_TOKEN }}",
  TURBO_REMOTE_CACHE_SIGNATURE_KEY: "${{ secrets.TURBO_WRITER_SIGNATURE_KEY }}",
} as const;

/**
 * Put the writer's token + key back at JOB level of ci.yml#check (the
 * f7fe0cc layout) and drop them from every step.
 */
function writerSecretsAtJobLevel(doc: Document): void {
  const steps = doc.getIn(["jobs", "check", "steps"]);
  if (isSeq(steps)) {
    for (const s of steps.items) {
      if (!isMap(s)) continue;
      const env = s.get("env");
      if (!isMap(env)) continue;
      for (const k of Object.keys(WRITER_SECRETS)) env.delete(k);
      if (env.items.length === 0) s.delete("env");
    }
  }
  for (const [k, v] of Object.entries(WRITER_SECRETS)) doc.setIn(["jobs", "check", "env", k], v);
}

export interface Mutation {
  id: string;
  /** What the review reproduced / what the shape is. */
  shape: string;
  apply: (root: string) => void;
}

const CACHE_STEP = (path: string, uses = "actions/cache@v4") => ({
  name: "Cache turbo",
  uses,
  with: { path, key: "turbo-${{ github.sha }}" },
});

export const MUTATIONS: readonly Mutation[] = [
  {
    id: "C1a env-format-expr",
    shape: "PR job `format`: environment: ${{ format('turbo-{0}-writer','cache') }}",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        d.setIn(["jobs", "format", "environment"], "${{ format('turbo-{0}-writer','cache') }}"),
      ),
  },
  {
    id: "C1b env-concat-expr",
    shape: "PR job `format`: environment: turbo-cache-${{ 'writer' }}",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        d.setIn(["jobs", "format", "environment"], "turbo-cache-${{ 'writer' }}"),
      ),
  },
  {
    id: "C1c env-expr+toJSON",
    shape: "C1a plus run: echo '${{ toJSON(secrets) }}'",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) => {
        d.setIn(["jobs", "format", "environment"], "${{ format('turbo-{0}-writer','cache') }}");
        addStep(d, "format", { run: "echo '${{ toJSON(secrets) }}'" });
      }),
  },
  {
    id: "C2a secrets[format()]",
    shape: "PR job: ${{ secrets[format('TURBO_{0}','TOKEN')] }}",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        addStep(d, "format", {
          run: "echo \"${{ secrets[format('TURBO_{0}','TOKEN')] }}\" | base64",
        }),
      ),
  },
  {
    id: "C2b toJSON(secrets)",
    shape: "PR job: run: echo '${{ toJSON(secrets) }}'",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        addStep(d, "format", { run: "echo '${{ toJSON(secrets) }}'" }),
      ),
  },
  {
    id: "C2c secrets: inherit",
    shape:
      "PR job calls a local reusable workflow with secrets: inherit; callee echoes toJSON(secrets)",
    apply: (r) => {
      writeFileSync(
        wf(r, "leak.yml"),
        "name: Leak\non:\n  workflow_call:\njobs:\n  dump:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo '${{ toJSON(secrets) }}'\n",
      );
      editWorkflow(r, "ci.yml", (d) =>
        d.setIn(
          ["jobs", "leak"],
          d.createNode({ uses: "./.github/workflows/leak.yml", secrets: "inherit" }),
        ),
      );
    },
  },
  {
    id: "C2d secrets: inherit (clean callee)",
    shape: "secrets: inherit into a callee that references nothing",
    apply: (r) => {
      writeFileSync(
        wf(r, "noop-callee.yml"),
        "name: Callee\non:\n  workflow_call:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
      );
      editWorkflow(r, "ci.yml", (d) =>
        d.setIn(
          ["jobs", "leak"],
          d.createNode({ uses: "./.github/workflows/noop-callee.yml", secrets: "inherit" }),
        ),
      );
    },
  },
  {
    id: "C2e format(secrets.X)",
    shape:
      "an allowlisted secret passed through format(): ${{ format('{0}', secrets.FLY_API_TOKEN) }}",
    apply: (r) =>
      editWorkflow(r, "deploy-auditor.yml", (d) =>
        addStep(d, "deploy", {
          run: "echo \"${{ format('{0}', secrets.FLY_API_TOKEN) }}\"",
        }),
      ),
  },
  {
    id: "C3a cache .turbo (PR)",
    shape: "PR job `format`: uses: actions/cache with path: .turbo",
    apply: (r) => editWorkflow(r, "ci.yml", (d) => addStep(d, "format", CACHE_STEP(".turbo"), 3)),
  },
  {
    id: "C3b cache turbo (release)",
    shape: "release.yml: actions/cache/restore with path: node_modules/.cache/turbo",
    apply: (r) =>
      editWorkflow(r, "release.yml", (d) =>
        addStep(
          d,
          "release",
          CACHE_STEP("node_modules/.cache/turbo", "actions/cache/restore@v4"),
          1,
        ),
      ),
  },
  {
    id: "C3c cache **/dist",
    shape: "PR job: actions/cache with path: **/dist",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        addStep(d, "format", CACHE_STEP("packages/*/dist\n**/dist\n"), 3),
      ),
  },
  {
    id: "C3d cache path expr",
    shape: "PR job: actions/cache with path: ${{ vars.CACHE_PATH }}",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        addStep(d, "format", CACHE_STEP("${{ vars.CACHE_PATH }}"), 3),
      ),
  },
  {
    id: "C4 committed .turbo/config.json",
    shape: 'git add -f .turbo/config.json = {"signature":false}',
    apply: (r) => {
      mkdirSync(join(r, ".turbo"), { recursive: true });
      writeFileSync(join(r, ".turbo", "config.json"), '{"signature":false}\n');
      git(r, "add", "-f", ".turbo/config.json");
    },
  },
  {
    id: "P1 writer env job-level",
    shape: "ci.yml#check: TURBO_TOKEN / signing key at JOB level (every step sees them)",
    apply: (r) => editWorkflow(r, "ci.yml", writerSecretsAtJobLevel),
  },
  {
    id: "P2 writer secret on non-turbo step",
    shape: "ci.yml#check: the writer token on the `Install dependencies` step",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) => {
        const i = stepIndex(d, "check", /^Install dependencies$/);
        d.setIn(["jobs", "check", "steps", i, "env", "TURBO_TOKEN"], WRITER_SECRETS.TURBO_TOKEN);
      }),
  },
  {
    id: "P3 writer secret in run text",
    shape: "ci.yml#check: ${{ secrets.TURBO_WRITER_SIGNATURE_KEY }} inside a run: script",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        addStep(d, "check", { run: "echo ${{ secrets.TURBO_WRITER_SIGNATURE_KEY }} > /tmp/k" }),
      ),
  },
  {
    id: "S1 unknown secret name",
    shape: "PR job: env FOO: ${{ secrets.SOME_NEW_SECRET }}",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        addStep(d, "format", { run: "true", env: { FOO: "${{ secrets.SOME_NEW_SECRET }}" } }),
      ),
  },
  {
    id: "S2 known secret, wrong job",
    shape: "PR job `format`: ${{ secrets.FLY_API_TOKEN }} (allowlisted only for deploy jobs)",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        addStep(d, "format", {
          run: "true",
          env: { FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN }}" },
        }),
      ),
  },
  {
    id: "S3 secret in if:",
    shape: "PR job step: if: ${{ secrets.SOME_NEW_SECRET != '' }}",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        addStep(d, "format", { if: "secrets.SOME_NEW_SECRET != ''", run: "true" }),
      ),
  },
  {
    id: "E1 environment from vars",
    shape: "PR job `format`: environment: ${{ vars.X }}",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) => d.setIn(["jobs", "format", "environment"], "${{ vars.X }}")),
  },
  {
    id: "E2 environment object from vars",
    shape: "PR job `format`: environment: { name: ${{ vars.X }} }",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        d.setIn(["jobs", "format", "environment"], d.createNode({ name: "${{ vars.X }}" })),
      ),
  },
  {
    id: "E3 literal env, wrong job",
    shape: "PR job `format`: environment: production (allowlisted only for archetype-conformance)",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) => d.setIn(["jobs", "format", "environment"], "production")),
  },
  {
    id: "E4 writer expr, wrong job",
    shape: "PR job `format`: the writer's exact guarded expression",
    apply: (r) =>
      editWorkflow(r, "ci.yml", (d) =>
        d.setIn(
          ["jobs", "format", "environment"],
          "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'turbo-cache-writer' || '' }}",
        ),
      ),
  },
];
