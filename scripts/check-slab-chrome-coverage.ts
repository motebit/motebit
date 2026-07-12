/**
 * Slab-chrome matrix cross-surface coverage gate.
 *
 * Closed-registry / structural-lock pattern (same shape as #79
 * `check-universal-slash-coverage`, #10 `check-suite-declared`, #46
 * `check-audience-canonical`, #85 `check-artifact-type-canonical`,
 * #92 `check-transparency-processors-canonical`, #93
 * `check-publishable-package-metadata`):
 *
 *   1. The slab chrome's render IS `f(controlState × embodimentMode)`
 *      ([`chrome-as-state-render.md`] § "The principle"). The matrix
 *      is the architectural primitive; every surface that mounts a
 *      slab dispatches against the full matrix shape.
 *   2. SLAB_SURFACES is the closed inventory of surfaces that own a
 *      dispatcher. Web (PR 1, 2026-05-12), mobile (PR 2, 2026-05-13),
 *      spatial (PR 3, 2026-05-13) — three registered surfaces below.
 *      Desktop chrome remains deferred — no slab dispatcher exists
 *      there yet.
 *   3. CONTROL_STATES + DEFERRED_EMBODIMENT_MODES are the closed
 *      inventories of cells the dispatcher must STRUCTURALLY name in
 *      source. Every control state appears in some switch / case;
 *      every deferred embodiment is referenced (so the dispatcher
 *      proves it intentionally returns null for those columns).
 *
 * Without this gate, the doctrine is one-instance-deep: a future
 * surface (desktop, AR-glasses) could mount a slab with a chrome
 * that handles only `motebit` state and silently drops the others,
 * or fails to acknowledge the deferred embodiment columns, and the
 * matrix-as-primitive claim collapses. With the gate, the contract
 * is structural: shipping a new slab surface MUST extend
 * SLAB_SURFACES, and at that moment the gate forces every control
 * state + every deferred mode to be named in the new dispatcher's
 * source.
 *
 * Why this gate generalizes rather than locks specific patterns: the
 * implementation language is surface-native. Web's dispatcher
 * returns `HTMLElement | null`; mobile's returns `SlabChromeCell |
 * null`. A future React-renderer surface might dispatch with
 * conditionals rather than switch statements. The gate checks that
 * every closed-registry member is REFERENCED in the source, leaving
 * the dispatch shape to the surface — same conservative-pattern
 * discipline as `check-universal-slash-coverage`'s per-surface
 * `patternFor` builder.
 *
 * Doctrine: `docs/doctrine/chrome-as-state-render.md` §
 * "Spatial-as-endgame validation" + § "PR 2 scope (mobile, this
 * commit)"; `docs/drift-defenses.md` § "synchronization invariants
 * are the meta-principle".
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface SlabSurface {
  /** Human-readable name for error messages. */
  readonly name: string;
  /** Path relative to repo root. */
  readonly file: string;
  /**
   * The surface's dispatcher entry-point identifier. Must appear as
   * an exported function/const in the file. A rename or accidental
   * removal of the dispatcher entry-point gets caught at the
   * entry-existence step before per-cell coverage runs.
   */
  readonly entry: string;
}

const SLAB_SURFACES: ReadonlyArray<SlabSurface> = [
  {
    name: "web",
    file: "apps/web/src/ui/slab-chrome.ts",
    entry: "renderSlabChrome",
  },
  {
    name: "mobile",
    file: "apps/mobile/src/slab-chrome.ts",
    entry: "dispatchSlabChrome",
  },
  {
    name: "spatial",
    file: "apps/spatial/src/slab-chrome.ts",
    entry: "dispatchSlabChrome",
  },
];

/**
 * `ControlState` kinds (closed protocol union per
 * `packages/protocol/src/co-browse.ts`). Every slab dispatcher MUST
 * structurally handle each kind — the cobrowse-default-as-only-
 * register polarity error the doctrine corrects was exactly the
 * "one branch, four states" shape.
 */
const CONTROL_STATES = ["user", "motebit", "handoff_pending", "paused"] as const;

/**
 * Embodiment columns named in the matrix but deferred to PR N per
 * `chrome-as-state-render.md` § "PR 1 scope (Out of scope)".
 * `virtual_browser` is the column with shipping content — it's NOT
 * in this list. Every dispatcher's source MUST reference each
 * deferred mode (so the matrix-as-primitive claim composes: the
 * dispatcher knows what it returns null for and why).
 */
const DEFERRED_EMBODIMENT_MODES = [
  "mind",
  "tool_result",
  "shared_gaze",
  "desktop_drive",
  "peer_viewport",
] as const;

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

interface Violation {
  readonly surface: string;
  readonly file: string;
  readonly kind:
    "missing_file" | "missing_entry" | "missing_control_state" | "missing_deferred_mode";
  readonly cell?: string;
}

function main(): void {
  const violations: Violation[] = [];

  for (const surface of SLAB_SURFACES) {
    const source = readFile(surface.file);
    if (source === null) {
      violations.push({ surface: surface.name, file: surface.file, kind: "missing_file" });
      continue;
    }
    // Entry-point presence — a rename / accidental removal of the
    // dispatcher itself is the first failure mode.
    if (!new RegExp(`\\b${surface.entry}\\b`).test(source)) {
      violations.push({ surface: surface.name, file: surface.file, kind: "missing_entry" });
      continue;
    }
    // Every control state must appear as a string literal in the
    // dispatcher's source — surface-agnostic check that the
    // dispatcher considers the state. Whether via `case "<state>"`
    // (switch) or `state.kind === "<state>"` (conditional) is left
    // to the surface; the gate only requires the literal mention.
    for (const state of CONTROL_STATES) {
      // Accept double-quoted, single-quoted, or backtick-quoted
      // mention — the doctrine's contract is "named in the matrix"
      // (`chrome-as-state-render.md` § "PR 1 scope (Out of scope)"),
      // and naming can be via code literal (`case "<state>"`) OR
      // dispatcher-file JSDoc (`` `<state>` `` in a block comment
      // documenting the cell). Both are first-class — web's
      // dispatcher names the cobrowse-delegated states in JSDoc;
      // mobile's pure dispatcher names them in switch cases. Same
      // doctrinal weight.
      const stateLiteralPattern = new RegExp(`[\`"']${state}[\`"']`);
      if (!stateLiteralPattern.test(source)) {
        violations.push({
          surface: surface.name,
          file: surface.file,
          kind: "missing_control_state",
          cell: state,
        });
      }
    }
    // Every deferred embodiment must appear in the source so the
    // dispatcher proves it intentionally returns null (or routes
    // these columns to a documented PR-N future). Same string-
    // literal check as above.
    for (const mode of DEFERRED_EMBODIMENT_MODES) {
      const modeLiteralPattern = new RegExp(`[\`"']${mode}[\`"']`);
      if (!modeLiteralPattern.test(source)) {
        violations.push({
          surface: surface.name,
          file: surface.file,
          kind: "missing_deferred_mode",
          cell: mode,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `check-slab-chrome-coverage: ${violations.length} matrix-coverage violation(s) across ${SLAB_SURFACES.length} slab surface(s):`,
    );
    const bySurface = new Map<string, Violation[]>();
    for (const v of violations) {
      const list = bySurface.get(v.surface) ?? [];
      list.push(v);
      bySurface.set(v.surface, list);
    }
    for (const [surfaceName, surfaceViolations] of bySurface) {
      console.error("");
      console.error(`  ${surfaceName}:`);
      for (const v of surfaceViolations) {
        switch (v.kind) {
          case "missing_file":
            console.error(`    - dispatcher file not found: ${v.file}`);
            break;
          case "missing_entry":
            console.error(`    - dispatcher entry-point not present in ${v.file}`);
            break;
          case "missing_control_state":
            console.error(`    - control state "${v.cell}" not handled in ${v.file}`);
            break;
          case "missing_deferred_mode":
            console.error(`    - deferred embodiment "${v.cell}" not referenced in ${v.file}`);
            break;
        }
      }
    }
    console.error("");
    console.error(
      "The slab chrome's render is `f(controlState × embodimentMode)`. Every surface that",
    );
    console.error(
      "mounts a slab MUST dispatch against the full matrix: every ControlState kind handled,",
    );
    console.error(
      "every deferred embodiment named. Doctrine: docs/doctrine/chrome-as-state-render.md.",
    );
    console.error("");
    console.error(
      "If the dispatcher genuinely doesn't need to reference a cell, the doctrine has changed —",
    );
    console.error("update SLAB_SURFACES / CONTROL_STATES / DEFERRED_EMBODIMENT_MODES in this gate");
    console.error("AND the doctrine memo in the same pass.");
    process.exit(1);
  }

  console.log(
    `✓ check-slab-chrome-coverage: ${SLAB_SURFACES.length} surface(s) × ${CONTROL_STATES.length} control state(s) + ${DEFERRED_EMBODIMENT_MODES.length} deferred embodiment(s) — matrix fully covered.`,
  );
}

main();
