/**
 * Trust slash-command cross-surface drift gate.
 *
 * The `/trust` slash command surfaces the canonical 5-dimension trust-
 * accumulation summary (memories + conversations + receipts + deletions
 * + peers) computed by `cmdTrust` in `@motebit/runtime/commands/system.ts`.
 * Every chat-surface that ships a slash command registry MUST register
 * `/trust` so the thesis claim "accumulated trust is visible on every
 * surface" holds at CI, not just at user encounter.
 *
 * Without this gate the contract is silently per-surface: a new surface
 * (or a contributor adding a slash list to an existing one) could ship
 * green without `/trust`, breaking the cross-surface visibility
 * invariant the trust-accumulation arc named. The four currently in-
 * scope surfaces — web/desktop/mobile/CLI — all use their own slash
 * list (web's autocomplete uses `SLASH_COMMANDS`, mobile uses an inline
 * `SLASH_COMMANDS` array, desktop the same, CLI uses `COMMANDS` in
 * `args.ts`); the literal substring `"trust"` must appear as a name /
 * usage entry in each.
 *
 * Spatial is intentionally out of scope: no chat surface, no slash
 * commands — the AR-glasses prototype's affordances are creature /
 * satellite / environment / attractor / presentation primitives, not
 * a slash menu. If spatial gains a chat surface, add it to SURFACES.
 *
 * The gate's shape matches `check-skills-cross-surface` (#73): a
 * canonical registry of (surface_name, file_path, signature_pattern)
 * tuples, each verified against the on-disk file. The signature is
 * the surface-native slash registration shape (e.g. `name: "trust"`
 * vs `usage: "/trust"`); each gets its own pattern so the gate doesn't
 * over-match on cross-surface name collisions.
 *
 * Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md`
 * (trust-accumulation visibility arc) + `docs/drift-defenses.md` § the
 * "synchronization invariants are the meta-principle" pattern.
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
   * The literal substring that registers `/trust` on this surface. Each
   * surface has its own registration shape (web/desktop/mobile use
   * `{ name: "trust", description: ... }`; CLI uses `{ usage: "/trust"
   * | "/trust ...", desc: ... }`). The pattern is conservative —
   * matches the canonical shape exactly. A surface that grows a
   * different shape adjusts this pattern at the same commit that lands
   * the new shape.
   */
  readonly pattern: RegExp;
}

const SURFACES: ReadonlyArray<Surface> = [
  {
    name: "web",
    file: "apps/web/src/ui/slash-commands.ts",
    pattern: /\bname:\s*"trust"/,
  },
  {
    name: "desktop",
    file: "apps/desktop/src/ui/slash-commands.ts",
    pattern: /\bname:\s*"trust"/,
  },
  {
    name: "mobile",
    file: "apps/mobile/src/components/SlashAutocomplete.tsx",
    pattern: /\bname:\s*"trust"/,
  },
  {
    name: "cli",
    file: "apps/cli/src/args.ts",
    // CLI uses `usage: "/trust"` (or `"/trust <subform>"`). The trailing
    // optional-space-or-quote anchor keeps the match scoped — `/trustfoo`
    // wouldn't match but `/trust` and `/trust <arg>` both do.
    pattern: /\busage:\s*"\/trust(?:\s|")/,
  },
];

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

function main(): void {
  const missing: string[] = [];
  const unreadable: string[] = [];

  for (const surface of SURFACES) {
    const source = readFile(surface.file);
    if (source === null) {
      unreadable.push(`${surface.name} (${surface.file})`);
      continue;
    }
    if (!surface.pattern.test(source)) {
      missing.push(`${surface.name} (${surface.file})`);
    }
  }

  if (unreadable.length > 0) {
    console.error(
      `check-trust-slash-cross-surface: could not read surface file(s):\n  ${unreadable.join("\n  ")}`,
    );
    console.error("");
    console.error("If a surface was renamed or removed, update SURFACES in this script.");
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      `check-trust-slash-cross-surface: ${missing.length} surface(s) missing /trust slash registration:`,
    );
    for (const m of missing) console.error(`  - ${m}`);
    console.error("");
    console.error("The /trust slash command surfaces the canonical 5-dimension trust-accumulation");
    console.error("summary (memories + conversations + receipts + deletions + peers). Every chat");
    console.error("surface MUST register it — the thesis claim 'accumulated trust is visible on");
    console.error("every surface' holds at CI, not just at user encounter. Add `/trust` to the");
    console.error("named file's slash list, matching the surface-native registration shape.");
    process.exit(1);
  }

  console.log(`✓ check-trust-slash-cross-surface: ${SURFACES.length} surface(s) register /trust.`);
}

main();
