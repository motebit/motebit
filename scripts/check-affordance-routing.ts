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
/**
 * The gate scans EVERY app source file, not a hand-listed set of UI
 * subdirectories.
 *
 * It previously scanned `["ui", "commands"]` only, and the aperture was the
 * whole problem: of nine apps, six scanned ZERO files, and the CLI — the lead
 * surface — scanned exactly one, because `commands/` holds a single file while
 * its 36 real subcommands live in `subcommands/`. Mobile's affordances are in
 * `components/`, spatial's are flat in `src/`, inspector's and operator's in
 * `components/`. 57 of 322 app source files were looked at: 18%.
 *
 * A gate enforcing surface determinism — a core CLAUDE.md invariant — was blind
 * to four of the five surfaces it names, and still printed "9 apps clean".
 *
 * A hardcoded subdirectory list is a moving target: it encodes today's layout
 * and silently narrows every time a surface grows a directory. Walking all of
 * `src/` (minus tests) cannot drift — a new directory is covered the moment it
 * exists. That is the same reason `check-panel-controllers` scans `ui/` OR
 * `components/`, generalized one step further.
 */
const TEST_DIR_SEGMENTS = ["__tests__", "e2e", "__mocks__"];

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
  /** Files actually scanned per app — the aperture, reported with the verdict. */
  const scanned = new Map<string, number>();
  for (const app of APPS) {
    const srcDir = resolve(ROOT, "apps", app, "src");
    const files = [...walkTypeScript(srcDir)].filter(
      (f) => !TEST_DIR_SEGMENTS.some((seg) => f.includes(`/${seg}/`)),
    );
    scanned.set(app, files.length);
    for (const file of files) all.push(...scanFile(app, file));
  }

  // Report the APERTURE alongside the verdict. "Clean" and "scanned nothing"
  // are different claims, and the previous message conflated them — it printed
  // "9 apps clean" while six of those apps had zero files in scope. An app with
  // no files scanned is named explicitly rather than counted as passing.
  const blind = APPS.filter((a) => (scanned.get(a) ?? 0) === 0);
  const totalFiles = [...scanned.values()].reduce((a, b) => a + b, 0);

  // Structural signal the pattern-matcher CANNOT reach.
  //
  // This gate detects a NARROW anti-pattern: an AI-loop call whose arguments
  // carry capability-routing signals. A surface that routes every affordance
  // through ordinary prose prompts matches nothing and passes silently — so
  // "0 violations" means "no prompt-constructed capability routing found", not
  // "all affordances are deterministic". Widening the aperture (57 → 322 files)
  // proved the repo clean of the narrow pattern and, in the same run, proved the
  // detector blind to the broad one.
  //
  // What IS checkable: a surface that drives the AI loop while never calling
  // `invokeCapability` has no deterministic path at all. That is not
  // automatically a violation — a chat-only surface legitimately has no
  // capability affordances — so it is reported, never failed. Deciding which of
  // its affordances owe a capability is design work, not pattern-matching.
  const noDeterministicPath = APPS.filter((app) => {
    const dir = resolve(ROOT, "apps", app, "src");
    let aiLoop = 0;
    let capability = 0;
    for (const file of walkTypeScript(dir)) {
      if (TEST_DIR_SEGMENTS.some((seg) => file.includes(`/${seg}/`))) continue;
      const src = readFileSync(file, "utf-8");
      if (AI_LOOP_CALLS.test(src)) aiLoop++;
      if (/\binvokeCapability\s*\(/.test(src)) capability++;
    }
    return aiLoop > 0 && capability === 0;
  });

  if (all.length === 0) {
    console.log(
      `Affordance routing check passed — ${totalFiles} file(s) scanned across ${APPS.length} apps`,
    );
    if (blind.length > 0) {
      console.log(
        `  NOTE: ${blind.length} app(s) had no source files in scope and were therefore ` +
          `not assessed, not proven clean: ${blind.join(", ")}`,
      );
    }
    if (noDeterministicPath.length > 0) {
      console.log(
        `  NOTE: ${noDeterministicPath.length} surface(s) drive the AI loop but never call ` +
          `\`invokeCapability\` — no deterministic affordance path exists there at all: ` +
          `${noDeterministicPath.join(", ")}.\n` +
          `        Not a failure (a chat-only surface legitimately has none), and not ` +
          `something this gate's\n        pattern-matcher can adjudicate — but it is where ` +
          `surface-determinism is least likely to hold.\n        Tracked as #545 finding 4.`,
      );
    }
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
