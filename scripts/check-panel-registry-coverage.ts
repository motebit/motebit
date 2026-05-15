/**
 * Panel-registry coverage gate.
 *
 * Closed-registry / structural-lock pattern — same shape as
 * #79 `check-universal-slash-coverage`,
 * #94 `check-slab-chrome-coverage`,
 * #95 `check-routing-decision-coverage`.
 *
 *   1. `SIDE_RAIL_PANELS` in `packages/panels/src/registry.ts` is
 *      the typed source of truth for the six side-rail panels —
 *      `docs/doctrine/panel-temporal-registers.md` names the
 *      identity / runtime split, `docs/doctrine/records-vs-acts.md`
 *      names panels as records, `docs/doctrine/panel-presentation-modes.md`
 *      names the per-surface availability matrix.
 *   2. Every registered panel id MUST have a mount site on each of
 *      the three flat surfaces (web / desktop / mobile). The mount
 *      site is a concrete fingerprint string in a known consumer
 *      file — the controller initializer, controller import, or
 *      React component import. A surface that silently drops a
 *      panel reopens the per-surface drift window the registry
 *      exists to close.
 *   3. Sibling-alignment: `PANEL_MOUNT_SITES` keys MUST mirror
 *      `SIDE_RAIL_PANELS` ids exactly. A registry append (a 7th
 *      panel) without adding mount-site entries fails this gate.
 *      A mount-site entry whose id is not in the registry fails
 *      this gate. The two sides must remain in lockstep.
 *
 * **Note on what this gate does NOT enforce.** The mode of opening
 * a panel varies by surface and by panel: web's Capabilities is
 * URL-driven (`/capabilities` route, no HUD button); web's
 * Sovereign has a HUD button; mobile uses a state-driven sheet for
 * every panel. The gate scans for the mount-site fingerprint
 * (controller wired up, component imported), not the opening
 * affordance. The affordance is a per-panel design decision
 * documented in the surface code; the registry is the structural
 * invariant the gate enforces.
 *
 * Doctrine: `docs/doctrine/panel-temporal-registers.md`,
 * `docs/doctrine/panel-presentation-modes.md`,
 * `docs/doctrine/records-vs-acts.md`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

type PanelSurface = "web" | "desktop" | "mobile";

interface PanelMountSite {
  readonly surface: PanelSurface;
  readonly file: string;
  /**
   * Concrete fingerprint string that, if present in the file,
   * proves the panel is mounted on this surface. Conventions:
   *   - web/desktop: the controller initializer name
   *     (`initSovereignPanels`, `initCapabilities`) or controller
   *     factory (`createMemoryController`, `getGoalsRunner`).
   *   - mobile: the panel component name as imported
   *     (`SovereignPanel`, `CapabilitiesPanel`).
   */
  readonly fingerprint: string;
}

/**
 * Per-panel mount-site map. The keys mirror `SIDE_RAIL_PANELS` ids
 * exactly (enforced by the sibling-alignment block in `main()`).
 *
 * For each panel × surface, the gate verifies the file exists AND
 * contains the fingerprint. Either condition failing means a panel
 * is registered but not mounted — the structural drift the
 * registry exists to catch.
 */
const PANEL_MOUNT_SITES: Record<string, ReadonlyArray<PanelMountSite>> = {
  sovereign: [
    { surface: "web", file: "apps/web/src/main.ts", fingerprint: "initSovereignPanels" },
    { surface: "desktop", file: "apps/desktop/src/main.ts", fingerprint: "initSovereign" },
    { surface: "mobile", file: "apps/mobile/src/App.tsx", fingerprint: "SovereignPanel" },
  ],
  memory: [
    // Web's Memory is hosted inside gated-panels.ts via the
    // @motebit/panels createMemoryController controller (shared
    // with Agents + Goals in the same file).
    {
      surface: "web",
      file: "apps/web/src/ui/gated-panels.ts",
      fingerprint: "createMemoryController",
    },
    { surface: "desktop", file: "apps/desktop/src/main.ts", fingerprint: "initMemory" },
    { surface: "mobile", file: "apps/mobile/src/App.tsx", fingerprint: "MemoryPanel" },
  ],
  conversations: [
    { surface: "web", file: "apps/web/src/main.ts", fingerprint: "initConversations" },
    { surface: "desktop", file: "apps/desktop/src/main.ts", fingerprint: "initConversations" },
    // Mobile component name matches the canonical plural registry
    // id (`conversations`). The component is in
    // `apps/mobile/src/components/ConversationsPanel.tsx`.
    { surface: "mobile", file: "apps/mobile/src/App.tsx", fingerprint: "ConversationsPanel" },
  ],
  capabilities: [
    { surface: "web", file: "apps/web/src/main.ts", fingerprint: "initCapabilitiesPanel" },
    { surface: "desktop", file: "apps/desktop/src/main.ts", fingerprint: "initCapabilities" },
    { surface: "mobile", file: "apps/mobile/src/App.tsx", fingerprint: "CapabilitiesPanel" },
  ],
  goals: [
    // Web's Goals is hosted in gated-panels.ts; the fingerprint
    // is the runner accessor the panel binds to (`getGoalsRunner`
    // pulls the shared `@motebit/panels` GoalsRunner).
    { surface: "web", file: "apps/web/src/ui/gated-panels.ts", fingerprint: "getGoalsRunner" },
    { surface: "desktop", file: "apps/desktop/src/main.ts", fingerprint: "initGoals" },
    { surface: "mobile", file: "apps/mobile/src/App.tsx", fingerprint: "GoalsPanel" },
  ],
  agents: [
    {
      surface: "web",
      file: "apps/web/src/ui/gated-panels.ts",
      fingerprint: "createAgentsController",
    },
    { surface: "desktop", file: "apps/desktop/src/main.ts", fingerprint: "initAgents" },
    { surface: "mobile", file: "apps/mobile/src/App.tsx", fingerprint: "AgentsPanel" },
  ],
};

const SURFACES: ReadonlyArray<PanelSurface> = ["web", "desktop", "mobile"];

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

/**
 * Parse `id: "..."` entries from the `SIDE_RAIL_PANELS` array in
 * `packages/panels/src/registry.ts`. Used for sibling-alignment —
 * the gate's `PANEL_MOUNT_SITES` keys must mirror these exactly.
 */
function readRegistryIds(): readonly string[] {
  const source = readFile("packages/panels/src/registry.ts");
  if (source === null) {
    console.error("check-panel-registry-coverage: could not read packages/panels/src/registry.ts");
    console.error("The panels registry is missing; this gate cannot validate.");
    process.exit(1);
  }
  const arrayMatch = source.match(/SIDE_RAIL_PANELS:[^=]*=\s*\[([\s\S]*?)\]\s*as\s*const/);
  if (arrayMatch === null) {
    console.error(
      "check-panel-registry-coverage: could not locate SIDE_RAIL_PANELS literal in registry.ts",
    );
    console.error(
      "Expected pattern: `export const SIDE_RAIL_PANELS: readonly SideRailPanel[] = [ ... ] as const`",
    );
    process.exit(1);
  }
  const body = arrayMatch[1] ?? "";
  const ids: string[] = [];
  const idPattern = /id:\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = idPattern.exec(body)) !== null) {
    ids.push(m[1] as string);
  }
  return ids;
}

interface Violation {
  readonly panel: string;
  readonly surface: PanelSurface;
  readonly file: string;
  readonly kind: "missing_file" | "missing_fingerprint";
  readonly detail?: string;
}

function main(): void {
  // === Sibling-alignment: PANEL_MOUNT_SITES keys must mirror
  // SIDE_RAIL_PANELS ids exactly. ================================
  const registryIds = readRegistryIds();
  const mountKeys = Object.keys(PANEL_MOUNT_SITES);

  const registryOnly = registryIds.filter((id) => !mountKeys.includes(id));
  const mountOnly = mountKeys.filter((id) => !registryIds.includes(id));

  if (registryOnly.length > 0 || mountOnly.length > 0) {
    console.error(
      "check-panel-registry-coverage: sibling-alignment failure between SIDE_RAIL_PANELS and this gate's PANEL_MOUNT_SITES.",
    );
    if (registryOnly.length > 0) {
      console.error(
        `  In registry but not in gate: ${registryOnly.map((id) => `"${id}"`).join(", ")}`,
      );
      console.error(
        "  → A panel landed in SIDE_RAIL_PANELS without mount-site entries here. Add one.",
      );
    }
    if (mountOnly.length > 0) {
      console.error(
        `  In gate but not in registry: ${mountOnly.map((id) => `"${id}"`).join(", ")}`,
      );
      console.error(
        "  → The gate names a panel the registry doesn't. Remove it here or restore the registry entry.",
      );
    }
    console.error("");
    console.error(
      "Doctrine: docs/doctrine/panel-temporal-registers.md (the typed SIDE_RAIL_PANELS registry).",
    );
    process.exit(1);
  }

  // === Per-(panel × surface) mount-site coverage =================
  const violations: Violation[] = [];
  for (const id of registryIds) {
    const sites = PANEL_MOUNT_SITES[id] ?? [];
    const sitesBySurface = new Map(sites.map((s) => [s.surface, s]));
    for (const surface of SURFACES) {
      const site = sitesBySurface.get(surface);
      if (site === undefined) {
        violations.push({
          panel: id,
          surface,
          file: "(none declared)",
          kind: "missing_file",
          detail: `no mount-site entry for surface "${surface}" in this gate`,
        });
        continue;
      }
      const source = readFile(site.file);
      if (source === null) {
        violations.push({
          panel: id,
          surface,
          file: site.file,
          kind: "missing_file",
        });
        continue;
      }
      // Word-boundary match — a rename like `AgentsPanel` →
      // `AgentsPanelDisabled` would otherwise pass an `includes` check
      // even though the actual binding is broken. The fingerprint is
      // an identifier (component name, controller initializer, runner
      // accessor); identifiers in TS sit between non-word chars
      // (whitespace, punctuation), so `\b{name}\b` is the
      // structurally correct shape.
      const fingerprintEscaped = site.fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const fingerprintPattern = new RegExp(`\\b${fingerprintEscaped}\\b`);
      if (!fingerprintPattern.test(source)) {
        violations.push({
          panel: id,
          surface,
          file: site.file,
          kind: "missing_fingerprint",
          detail: site.fingerprint,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `check-panel-registry-coverage: ${violations.length} mount-site violation(s) across ${registryIds.length} panel(s) × ${SURFACES.length} surface(s):`,
    );
    const byPanel = new Map<string, Violation[]>();
    for (const v of violations) {
      const list = byPanel.get(v.panel) ?? [];
      list.push(v);
      byPanel.set(v.panel, list);
    }
    for (const [panel, panelViolations] of byPanel) {
      console.error("");
      console.error(`  panel "${panel}":`);
      for (const v of panelViolations) {
        switch (v.kind) {
          case "missing_file":
            console.error(`    - [${v.surface}] mount file not found: ${v.file}`);
            if (v.detail !== undefined) console.error(`      ${v.detail}`);
            break;
          case "missing_fingerprint":
            console.error(
              `    - [${v.surface}] ${v.file} does not contain fingerprint "${v.detail}"`,
            );
            console.error(
              "      → The surface dropped this panel, renamed the controller, or never wired it up.",
            );
            break;
        }
      }
    }
    console.error("");
    console.error(
      "Every panel in `SIDE_RAIL_PANELS` MUST be mounted on every flat surface (web / desktop / mobile).",
    );
    console.error(
      "If a panel was intentionally removed from a surface, remove it from the registry",
    );
    console.error(
      "first — the registry is the contract per docs/doctrine/panel-temporal-registers.md.",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-panel-registry-coverage: ${registryIds.length} panel(s) × ${SURFACES.length} surface(s) — every SIDE_RAIL_PANELS entry mounted on web / desktop / mobile.`,
  );
}

main();
