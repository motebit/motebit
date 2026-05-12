/**
 * Universal slash-command cross-surface coverage gate.
 *
 * Generalized from `check-trust-slash-cross-surface` (originally
 * locking only `/trust`) — closed registry of UNIVERSAL_COMMANDS that
 * every chat surface MUST register. A universal command is one that:
 *
 *   1. Surfaces a canonical thesis-pillar projection (`/trust` →
 *      accumulated state; `/welcome` → onboarding tour).
 *   2. Lives in `@motebit/runtime`'s shared command dispatcher
 *      (`packages/runtime/src/commands/index.ts`).
 *   3. Has the same meaning on every surface — no per-surface variant
 *      that would justify omission.
 *
 * Without this gate the contract is silently per-surface: a new
 * surface (or a contributor adding a slash list to an existing one)
 * could ship green without a universal command, breaking the cross-
 * surface visibility invariant the doctrine names. The four in-scope
 * surfaces — web/desktop/mobile/CLI — all use their own slash list
 * (web/desktop/mobile use `{ name, description }`; CLI uses
 * `{ usage, desc }`); each universal command must appear in each
 * surface's list, matching the surface-native registration shape.
 *
 * Spatial is intentionally out of scope: no chat surface, no slash
 * commands — the AR-glasses prototype's affordances are creature /
 * satellite / environment / attractor / presentation primitives, not
 * a slash menu. If spatial gains a chat surface, add it to SURFACES.
 *
 * Closed-registry shape (same as `check-typed-truth-perception` #80,
 * `check-skills-cross-surface` #73): UNIVERSAL_COMMANDS is the
 * canonical inventory. Adding a universal command MUST update both
 * the registry here AND each surface's slash list — the registry
 * update is the discipline trigger.
 *
 * Why generalize rather than ship per-command gates: the gates would
 * otherwise be near-duplicates with the only differentiator being the
 * command name. Generalizing turns the discipline into ONE rule
 * (the COMMANDS × SURFACES matrix) instead of N separate ones; future
 * universal commands cost one registry line, not a new script.
 *
 * Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md`
 * (trust-accumulation visibility arc + onboarding arc) +
 * `docs/drift-defenses.md` § the "synchronization invariants are the
 * meta-principle" pattern.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Surface {
  /** Human-readable name for error messages. */
  readonly name: string;
  /** Path relative to repo root. */
  readonly file: string;
  /**
   * The surface-native registration pattern for a slash command,
   * built from the command name. Returns a regex that matches the
   * literal shape this surface uses to register the command.
   *
   * Web/desktop/mobile use `{ name: "<X>", description: ... }` inside
   * their `SLASH_COMMANDS` arrays. CLI uses
   * `{ usage: "/<X>" | "/<X> <subform>", desc: ... }` inside its
   * `COMMANDS` array. Each surface gets its own builder so a future
   * shape change (e.g. desktop adopting `command: "<X>"`) adjusts at
   * one site, not N.
   */
  readonly patternFor: (cmd: string) => RegExp;
}

const SURFACES: ReadonlyArray<Surface> = [
  {
    name: "web",
    file: "apps/web/src/ui/slash-commands.ts",
    patternFor: (cmd) => new RegExp(`\\bname:\\s*"${cmd}"`),
  },
  {
    name: "desktop",
    file: "apps/desktop/src/ui/slash-commands.ts",
    patternFor: (cmd) => new RegExp(`\\bname:\\s*"${cmd}"`),
  },
  {
    name: "mobile",
    file: "apps/mobile/src/components/SlashAutocomplete.tsx",
    patternFor: (cmd) => new RegExp(`\\bname:\\s*"${cmd}"`),
  },
  {
    name: "cli",
    file: "apps/cli/src/args.ts",
    // CLI uses `usage: "/<cmd>"` or `"/<cmd> <subform>"`. The trailing
    // optional-space-or-quote anchor keeps the match scoped — `/cmdfoo`
    // wouldn't match but `/cmd` and `/cmd <arg>` both do.
    patternFor: (cmd) => new RegExp(`\\busage:\\s*"\\/${cmd}(?:\\s|")`),
  },
];

interface UniversalCommand {
  readonly name: string;
  readonly purpose: string;
}

const UNIVERSAL_COMMANDS: ReadonlyArray<UniversalCommand> = [
  {
    name: "trust",
    purpose:
      "canonical 5-dimension trust-accumulation summary (memories + conversations + signed receipts + signed deletions + federation peers) computed by cmdTrust — the thesis claim 'accumulated trust is visible on every surface'",
  },
  {
    name: "welcome",
    purpose:
      "onboarding tour naming the three thesis pillars (sovereign identity, accumulated trust, governance at the boundary) and pointing to universal slash commands — the forcing function for outside-observer testability at first encounter",
  },
];

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

interface Violation {
  readonly command: string;
  readonly purpose: string;
  readonly missingFrom: ReadonlyArray<string>;
}

function main(): void {
  const sourceCache = new Map<string, string | null>();
  for (const surface of SURFACES) {
    sourceCache.set(surface.name, readFile(surface.file));
  }

  // Surfaces whose source we couldn't read at all — surface file
  // renamed / moved without updating SURFACES.
  const unreadable: string[] = [];
  for (const surface of SURFACES) {
    if (sourceCache.get(surface.name) === null) {
      unreadable.push(`${surface.name} (${surface.file})`);
    }
  }
  if (unreadable.length > 0) {
    console.error(
      `check-universal-slash-coverage: could not read surface file(s):\n  ${unreadable.join("\n  ")}`,
    );
    console.error("");
    console.error("If a surface was renamed or removed, update SURFACES in this script.");
    process.exit(1);
  }

  // For each universal command, check every surface for the
  // surface-native registration pattern.
  const violations: Violation[] = [];
  for (const cmd of UNIVERSAL_COMMANDS) {
    const missingFrom: string[] = [];
    for (const surface of SURFACES) {
      const source = sourceCache.get(surface.name)!;
      if (!surface.patternFor(cmd.name).test(source)) {
        missingFrom.push(`${surface.name} (${surface.file})`);
      }
    }
    if (missingFrom.length > 0) {
      violations.push({ command: cmd.name, purpose: cmd.purpose, missingFrom });
    }
  }

  if (violations.length > 0) {
    console.error(
      `check-universal-slash-coverage: ${violations.length} universal command(s) missing surface registration:`,
    );
    for (const v of violations) {
      console.error("");
      console.error(`  /${v.command} — ${v.purpose}`);
      console.error(`    Missing from ${v.missingFrom.length} surface(s):`);
      for (const m of v.missingFrom) console.error(`      - ${m}`);
    }
    console.error("");
    console.error("A universal command surfaces a canonical thesis-pillar projection and lives");
    console.error("in @motebit/runtime's shared command dispatcher. Every chat surface MUST");
    console.error("register it — the thesis claim that accumulated trust + onboarding are");
    console.error("visible on every surface holds at CI, not just at user encounter. Add the");
    console.error("command to the named file's slash list, matching the surface-native shape.");
    process.exit(1);
  }

  console.log(
    `✓ check-universal-slash-coverage: ${UNIVERSAL_COMMANDS.length} command(s) × ${SURFACES.length} surface(s) — all cells covered.`,
  );
}

main();
