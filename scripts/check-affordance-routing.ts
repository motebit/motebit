/**
 * Affordance routing check.
 *
 * Surface affordances are deterministic. When a user explicitly authorizes a
 * capability via a UI control (chip tap, button click, slash command,
 * scene-object click, voice opt-in), the implementation MUST fire through
 * `invokeCapability(name, args)` — never by constructing a natural-language
 * prompt and routing it through `handleSend` / `sendMessageStreaming` /
 * `runChat` / the AI loop.
 *
 * This gate catches the anti-pattern statically. The motivating incident: a
 * "Review this PR" chip that told the model in English to delegate; the model
 * hallucinated a non-review reply because the affordance was advisory rather
 * than binding. The chip lied.
 *
 * See `docs/doctrine/surface-determinism.md` for the doctrine and the 14th
 * entry in `docs/drift-defenses.md` for the invariant this gate defends.
 *
 * ── Scope ──────────────────────────────────────────────────────────────
 *
 * Scanned: `apps/<app>/src/ui/**` and `apps/<app>/src/commands/**`. Those are
 * the top-level app layers where surface affordances live. Tests are excluded
 * — they legitimately construct prompts for assertion.
 *
 * Exit 1 on any violation. Runs in `pnpm check` alongside the other drift
 * gates. A fixture under `scripts/__tests__/affordance-routing-fixture/`
 * asserts the positive (clean code passes) and negative (a deliberate
 * violation fails) paths.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const APPS = [
  "cli",
  "desktop",
  "docs",
  "identity",
  "inspector",
  "mobile",
  "operator",
  "spatial",
  "web",
];
const UI_SUBDIRS = ["ui", "commands"];

const FIXTURE_DIR = resolve(__dirname, "__tests__", "affordance-routing-fixture");

// ── Anti-pattern signals ───────────────────────────────────────────────
// A violation is a line inside a UI file that:
//   (a) calls one of the AI-loop entry points (handleSend, sendMessageStreaming,
//       sendMessage, runTurnStreaming), AND
//   (b) the argument list contains a known signal of capability routing —
//       a "required_capabilities" string literal, a "delegate" + "remote agent"
//       construct, or a known capability-name string literal.
//
// The signals are conservative — detecting English-language prompts routed
// through the AI loop is brittle by its nature. The `required_capabilities`
// literal is the sharpest canary: any natural-language prompt that names it
// is trying to steer the model into the delegation tool, and that is exactly
// the drift this gate forbids.
const AI_LOOP_CALLS = /\b(handleSend|sendMessageStreaming|sendMessage|runTurnStreaming)\s*\(/;
const CAPABILITY_HINT_PATTERNS: ReadonlyArray<{ pattern: RegExp; msg: string }> = [
  {
    pattern: /required_capabilities\s*:/,
    msg: "constructs a prompt that names `required_capabilities` — route through `invokeCapability(name, args)` instead",
  },
  {
    pattern: /delegate[^"'`]{0,40}(remote agent|motebit network)/i,
    msg: "constructs a prompt that instructs the model to delegate — use `invokeCapability(name, args)` for user-explicit affordances",
  },
];

interface Violation {
  app: string;
  file: string;
  line: number;
  detail: string;
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      out.push(...walkTypeScript(path));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(path);
    }
  }
  return out;
}

function scanFile(app: string, file: string): Violation[] {
  const src = readFileSync(file, "utf-8");
  const violations: Violation[] = [];
  const shortPath = relative(ROOT, file);

  // Join a line with its next 4 lines so multi-line arg lists are still
  // visible to the single-line regex. Conservative window — big enough for
  // most formatted calls, small enough to stay fast.
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(i, i + 5).join("\n");
    if (!AI_LOOP_CALLS.test(window)) continue;
    for (const { pattern, msg } of CAPABILITY_HINT_PATTERNS) {
      if (pattern.test(window)) {
        violations.push({
          app,
          file: shortPath,
          line: i + 1,
          detail: msg,
        });
      }
    }
  }

  return violations;
}

function scanDirs(dirs: string[], appLabel: string): Violation[] {
  const out: Violation[] = [];
  for (const dir of dirs) {
    for (const file of walkTypeScript(dir)) {
      out.push(...scanFile(appLabel, file));
    }
  }
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const fixtureOnly = argv.includes("--fixture");

  if (fixtureOnly) {
    // Fixture mode — scan only the fixture directory. Used by the gate's own
    // unit test to assert the clean/violation detection round-trip without
    // failing on the real repo. The fixture's `violation.ts` MUST flag; the
    // fixture's `clean.ts` MUST NOT.
    const violations = scanDirs([FIXTURE_DIR], "fixture");
    const violationLines = violations.map((v) => `${v.file}:${v.line}`);
    process.stdout.write(JSON.stringify({ violations: violationLines }, null, 2) + "\n");
    process.exit(0);
  }

  const all: Violation[] = [];
  for (const app of APPS) {
    const dirs = UI_SUBDIRS.map((sd) => resolve(ROOT, "apps", app, "src", sd));
    all.push(...scanDirs(dirs, app));
  }

  if (all.length === 0) {
    console.log(`Affordance routing check passed — ${APPS.length} apps clean (${APPS.join(", ")})`);
    return;
  }

  console.error(`Affordance routing violations (${all.length}):\n`);
  let current = "";
  for (const v of all) {
    if (v.app !== current) {
      current = v.app;
      console.error(`  [${v.app}]`);
    }
    console.error(`    ${v.file}:${v.line} — ${v.detail}`);
  }
  console.error(
    `\nDoctrine: surface affordances are deterministic — docs/doctrine/surface-determinism.md.`,
  );
  console.error(
    `Fix: replace the constructed prompt with \`ctx.app.invokeCapability(<capability>, <args>)\`.`,
  );
  process.exit(1);
}

main();
