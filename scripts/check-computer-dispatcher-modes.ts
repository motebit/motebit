/**
 * `check-computer-dispatcher-modes` — every site that registers the
 * `computer` tool MUST stamp an explicit `embodimentMode` on the
 * registered ToolDefinition (or be the explicit `tool_result`
 * safe-floor fallback path declared in the central registry).
 *
 * Why this gate exists. The `computer` tool name is shared across
 * physically distinct dispatchers — cloud-browser (apps/web →
 * `CloudBrowserDispatcher`, isolated Chromium) and OS-drive
 * (apps/desktop → Tauri Rust bridge, real OS). Each is a different
 * embodiment per `motebit-computer.md` §"Embodiment modes": cloud →
 * `virtual_browser` (driver: motebit, observer: user, source:
 * isolated-browser, consent: session-scoped, sensitivity:
 * tier-bounded-by-source); desktop → `desktop_drive` (driver:
 * motebit, observer: user, source: real-os, consent: per-action,
 * sensitivity: all-tiers).
 *
 * If a registration site forgets to stamp the embodiment, the
 * runtime's `projectSlabForTurn` falls through to `tool-policy.ts`'s
 * generic `tool_result` floor — sensitivity routing remains honest
 * (`tier-bounded-by-tool` composes), but the embodiment-mode contract
 * silently under-claims. The slab gets the wrong mode contract; the
 * lifecycle defaults are wrong; consent expectations are wrong;
 * downstream affordances mis-resolve. The doctrine names this
 * exact failure: "Mode mixed into kind. Don't rename `fetch` to
 * `virtual_browser_fetch`. Kind is the fine-grained shape of the
 * content; mode is the coarse-grained embodiment category."
 *
 * What this gate enforces.
 *   - Discovery: find every TS file under `apps/` that registers
 *     the `computer` tool (uses `computerDefinition` from
 *     `@motebit/tools/web-safe` in a `registry.register(...)` call).
 *   - Coverage: each such site MUST either spread `computerDefinition`
 *     into a const that adds `embodimentMode: "<...>"`, OR appear in
 *     the `ALLOWLIST` below with a documented reason.
 *
 * Allowlist is empty at landing. Future surfaces that register
 * `computer` MUST stamp embodimentMode (or join the allowlist with
 * a "deferred until X" reason). The fallback safe-floor in
 * `tool-policy.ts` is intentionally name-keyed and surface-blind —
 * it exists for unknown future callers (e.g. an MCP-imported
 * `computer` tool from a federation peer), not as a dispenser
 * for surfaces that should know their own embodiment.
 *
 * Doctrine: motebit-computer.md §"v1 implementation status —
 * Deferred to v1.5+: per-dispatcher mode stamping" — landed as v1.1
 * of the virtual_browser arc.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Sites that register the `computer` tool but are explicitly excused
 * from declaring an embodimentMode. Empty at landing — future entries
 * MUST name a "deferred until X" reason.
 */
const ALLOWLIST: ReadonlyArray<{
  readonly file: string;
  readonly reason: string;
}> = [];

const VALID_MODES = new Set([
  "mind",
  "tool_result",
  "virtual_browser",
  "shared_gaze",
  "desktop_drive",
  "peer_viewport",
]);

interface RegistrationSite {
  readonly file: string;
  readonly stamped: string | null;
}

function findRegistrationSites(): RegistrationSite[] {
  // Registration sites: files that combine `registry.register(...)`
  // with `createComputerHandler(...)`. Files that only DEFINE
  // (`packages/tools/src/builtins/computer.ts` exports the
  // `computerDefinition` and `createComputerHandler` factory) or
  // re-export (`builtins/index.ts`, `web-safe.ts`) are not callers
  // of `registry.register` with a computer handler.
  const candidates = execSync(`grep -rln "createComputerHandler" apps --include="*.ts" || true`, {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.length > 0 && !line.includes("__tests__"))
    .filter((line) => !line.includes("/dist/"))
    .filter((line) => !line.includes("/node_modules/"))
    .filter((line) => !line.includes("/coverage/"))
    .filter((line) => !line.endsWith(".d.ts"));

  return candidates
    .map((relPath) => {
      const file = resolve(ROOT, relPath);
      const text = readFileSync(file, "utf8");

      // Filter to actual call sites: the file must invoke
      // `registry.register(...)` and pass `createComputerHandler(...)`
      // to it. Re-export-only files don't pass this.
      const isCallSite = /registry\.register\([\s\S]{0,400}?createComputerHandler/.test(text);
      if (!isCallSite) return null;

      // Detect the embodimentMode either:
      //   1. As a literal `embodimentMode: "<mode>"` in an object that
      //      also references `computerDefinition`.
      //   2. As a property on the registered definition by spread (e.g.
      //      `{ ...computerDefinition, embodimentMode: "<mode>" }`).
      // Both reduce to the same regex on the source text.
      const stampMatch = /embodimentMode\s*:\s*"([a-z_]+)"/m.exec(text);
      return { file: relPath, stamped: stampMatch?.[1] ?? null };
    })
    .filter((s): s is RegistrationSite => s !== null);
}

function main(): void {
  const sites = findRegistrationSites();

  if (sites.length === 0) {
    // No registration sites at all — the slate is clean. Future
    // additions will trip this check.
    console.log("check-computer-dispatcher-modes: no `computer` tool registration sites found");
    return;
  }

  const allowlistedFiles = new Set(ALLOWLIST.map((e) => e.file));
  const failures: Array<{ file: string; reason: string }> = [];

  for (const site of sites) {
    if (allowlistedFiles.has(site.file)) continue;

    if (site.stamped === null) {
      failures.push({
        file: site.file,
        reason:
          "registers the `computer` tool but does not stamp `embodimentMode`. " +
          'Add `{ ...computerDefinition, embodimentMode: "<mode>" }` per ' +
          'your dispatcher\'s embodiment (cloud-browser → "virtual_browser"; ' +
          'desktop → "desktop_drive"). See doctrine in motebit-computer.md ' +
          '§"Embodiment modes."',
      });
      continue;
    }

    if (!VALID_MODES.has(site.stamped)) {
      failures.push({
        file: site.file,
        reason:
          `stamps embodimentMode="${site.stamped}", which is not a valid ` +
          `EmbodimentMode. Valid: ${[...VALID_MODES].join(", ")}.`,
      });
    }
  }

  // Stale-allowlist detection: an allowlisted file that no longer
  // registers `computer` (or now correctly stamps embodimentMode)
  // shouldn't keep an allowlist entry.
  const siteFiles = new Set(sites.map((s) => s.file));
  for (const entry of ALLOWLIST) {
    if (!siteFiles.has(entry.file)) {
      failures.push({
        file: entry.file,
        reason:
          "ALLOWLIST entry references a file that no longer registers the " +
          "`computer` tool. Remove the stale allowlist entry.",
      });
    }
  }

  if (failures.length > 0) {
    console.error("check-computer-dispatcher-modes: violations detected\n");
    for (const f of failures) {
      console.error(`  ${f.file}`);
      console.error(`    ${f.reason}\n`);
    }
    process.exit(1);
  }

  console.log(
    `check-computer-dispatcher-modes: ${sites.length} registration site(s) all correctly stamped`,
  );
  for (const site of sites) {
    if (site.stamped !== null) {
      console.log(`  ${site.file} → ${site.stamped}`);
    }
  }
}

main();
