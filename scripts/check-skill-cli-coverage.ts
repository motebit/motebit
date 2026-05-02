#!/usr/bin/env tsx
/**
 * check-skill-cli-coverage — drift defense for SkillRegistry ↔ CLI verbs.
 *
 * Every public method on `SkillRegistry` should be reachable through a
 * `motebit skills <verb>` subcommand. If a contributor adds
 * `registry.fooBar()` and forgets to wire it into the CLI, users can't
 * invoke it — the registry method is shipped but unreachable.
 *
 * The probe parses two files via lightweight regex (no TypeScript AST —
 * keeps the gate fast and dependency-free):
 *
 *   1. packages/skills/src/registry.ts — public methods on `class SkillRegistry`
 *   2. apps/cli/src/index.ts — the `subcommand === "skills"` dispatch block
 *
 * Asserts every public method maps to a `skillsCmd === "<verb>"` arm.
 *
 * Drift class: "registry surface ↔ CLI verb coverage."
 *
 * Usage:
 *   tsx scripts/check-skill-cli-coverage.ts        # exit 1 on drift
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REGISTRY_FILE = join(ROOT, "packages", "skills", "src", "registry.ts");
const CLI_DISPATCH_FILE = join(ROOT, "apps", "cli", "src", "index.ts");

/**
 * Methods that exist on SkillRegistry but are intentionally NOT CLI verbs:
 *
 *   - `get` — internal lookup, used by other handlers; CLI surfaces info via
 *     `verify` and `list` instead.
 */
const INTENTIONAL_NON_CLI_METHODS = new Set<string>(["get"]);

/**
 * CLI verbs that are intentionally NOT registry methods — they are network-
 * side operations against the relay-hosted registry (spec/skills-registry-v1.md),
 * not the local-disk SkillRegistry surface this gate cross-checks. Adding a new
 * verb here is a one-line waiver; adding a new local-disk verb without a
 * registry method behind it should still fail.
 *
 *   - `publish` — POSTs a signed envelope to the relay's
 *     /api/v1/skills/submit endpoint. The local SkillRegistry never sees it.
 *   - `run-script` — phase 2 quarantine: spawns a script from the skill's
 *     `scripts/` tree gated through the canonical operator approval queue
 *     (`SqliteApprovalStore` from `@motebit/persistence`). The execution
 *     primitive is the OS spawn, not a SkillRegistry method; the registry
 *     only persists + serves the script bytes. See drift gate #69
 *     `check-skill-script-uses-tool-approval` for the approval-gate
 *     coverage check.
 */
const INTENTIONAL_NON_REGISTRY_VERBS = new Set<string>(["publish", "run-script"]);

/**
 * Map from registry method name → expected CLI subcommand verb. The default
 * mapping is identity (kebab-case lowering); this object overrides where the
 * names diverge.
 */
const METHOD_TO_VERB_OVERRIDE: Record<string, string> = {
  // None today — every public method maps 1:1.
};

function expectedVerbForMethod(method: string): string {
  if (METHOD_TO_VERB_OVERRIDE[method]) return METHOD_TO_VERB_OVERRIDE[method]!;
  return method;
}

interface Finding {
  loc: string;
  message: string;
}

const findings: Finding[] = [];

function fail(loc: string, message: string): void {
  findings.push({ loc, message });
}

/**
 * Extract public method names from `class SkillRegistry { ... }`. Matches:
 *   - `async install(`
 *   - `install(`
 * Excludes:
 *   - lines starting with `//` or `*`
 *   - private/protected (those are handled by their declared visibility, not
 *     here — TypeScript's default is public)
 *   - the constructor
 *   - methods named `private` (defensive, no false positives expected)
 */
function extractRegistryMethods(): Set<string> {
  if (!existsSync(REGISTRY_FILE)) {
    fail(
      "packages/skills/src/registry.ts",
      "file not found — registry has moved? update this gate's path constant",
    );
    return new Set();
  }
  const source = readFileSync(REGISTRY_FILE, "utf-8");

  // Find the SkillRegistry class block
  const classMatch = /export class SkillRegistry\b[\s\S]*?\n\}\s*$/m.exec(source);
  if (!classMatch) {
    fail(
      "packages/skills/src/registry.ts",
      "could not locate `export class SkillRegistry` — gate's regex needs updating",
    );
    return new Set();
  }
  const body = classMatch[0];

  const methods = new Set<string>();
  // Match top-level method declarations:
  //   `  async name(`  or  `  name(`
  // (Two-space indent inside a class. We allow `private`/`protected` but
  // exclude them.)
  const methodRegex = /^(?:  )(?!\/\/|\*|private |protected |#)(?:async\s+)?(\w+)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(body)) !== null) {
    const name = m[1]!;
    if (name === "constructor") continue;
    methods.add(name);
  }
  return methods;
}

/**
 * Extract `skillsCmd === "<verb>"` arms from the CLI dispatch block.
 */
function extractCliVerbs(): Set<string> {
  if (!existsSync(CLI_DISPATCH_FILE)) {
    fail(
      "apps/cli/src/index.ts",
      "file not found — CLI dispatch has moved? update this gate's path constant",
    );
    return new Set();
  }
  const source = readFileSync(CLI_DISPATCH_FILE, "utf-8");

  // Find the `if (subcommand === "skills") { ... }` block
  const blockMatch = /if\s*\(\s*subcommand\s*===\s*"skills"\s*\)\s*\{([\s\S]*?)^\s*\}\s*$/m.exec(
    source,
  );
  if (!blockMatch) {
    fail(
      "apps/cli/src/index.ts",
      'could not locate the `subcommand === "skills"` dispatch block — gate\'s regex needs updating',
    );
    return new Set();
  }
  const block = blockMatch[1] ?? "";

  const verbs = new Set<string>();
  const verbRegex = /skillsCmd\s*===\s*"([a-z][a-z0-9-]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = verbRegex.exec(block)) !== null) {
    verbs.add(m[1]!);
  }
  return verbs;
}

function main(): void {
  const methods = extractRegistryMethods();
  const verbs = extractCliVerbs();

  for (const method of methods) {
    if (INTENTIONAL_NON_CLI_METHODS.has(method)) continue;
    const expected = expectedVerbForMethod(method);
    if (!verbs.has(expected)) {
      fail(
        "apps/cli/src/index.ts",
        `SkillRegistry.${method}() has no \`skillsCmd === "${expected}"\` arm. ` +
          `Wire it into the dispatch block, or add \`${method}\` to INTENTIONAL_NON_CLI_METHODS in this gate.`,
      );
    }
  }

  // Reverse: every CLI verb should map to a registry method (catches typos).
  for (const verb of verbs) {
    if (INTENTIONAL_NON_REGISTRY_VERBS.has(verb)) continue;
    if (!methods.has(verb) && !Object.values(METHOD_TO_VERB_OVERRIDE).includes(verb)) {
      fail(
        "apps/cli/src/index.ts",
        `CLI verb "${verb}" has no SkillRegistry method backing it. Did you typo? ` +
          `Methods seen: ${[...methods].sort().join(", ")}.`,
      );
    }
  }

  if (findings.length === 0) {
    console.log(
      `✓ check-skill-cli-coverage: ${methods.size} registry method(s) and ${verbs.size} CLI verb(s) all aligned.`,
    );
    return;
  }

  console.error(`✗ check-skill-cli-coverage: ${findings.length} drift(s) detected.`);
  console.error("");
  for (const f of findings) {
    console.error(`  ${f.loc}`);
    console.error(`    ${f.message}`);
  }
  console.error("");
  process.exit(1);
}

main();
