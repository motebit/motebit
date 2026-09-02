/**
 * check-spec-routes — the annotation scanner must not punish a well-written
 * annotation, and must say which of three different things went wrong.
 *
 * Regression cover for #573. The `GET /api/v1/identity/:motebitId` block sat
 * exactly `PENDING_TTL_LINES` (12) below its own `/**`, because the TTL was
 * measured from the annotation's FIRST line. Adding one blank `*` line to a
 * multi-paragraph `@reason` pushed the route to 13 and the gate reported:
 *
 *   route "GET /api/v1/identity/:motebitId" has no @spec/@internal/@experimental annotation
 *
 * ...with five annotation tags sitting directly above it. The budget was doing
 * two jobs — "how far is the route" and "how long is the comment" — so the gate
 * was easiest to satisfy by writing a worse comment, and its repair instruction
 * pointed away from the cause (`docs/doctrine/gate-repair-instructions.md`).
 *
 * The fix anchors the TTL to the annotation's LAST line. These tests drive the
 * real gate over fixture files so they fail if either half regresses: the
 * length-independence, or the three distinct repair instructions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-spec-routes.ts");
const TARGET = resolve(ROOT, "services", "relay", "src", "identity-transparency.ts");

/** Run the gate against the real repo, with `TARGET` temporarily replaced. */
function runGateWith(source: string): string {
  const backup = `${TARGET}.gate-test-backup`;
  cpSync(TARGET, backup);
  try {
    writeFileSync(TARGET, source);
    const r = spawnSync("npx", ["tsx", SCRIPT], { cwd: ROOT, encoding: "utf8" });
    return `${r.stdout}\n${r.stderr}`;
  } finally {
    cpSync(backup, TARGET);
    rmSync(backup, { force: true });
  }
}

/** A minimal file carrying one annotated route, with `reason` lines injected. */
function fixture(opts: { reasonLines: string[]; tag?: string; filler?: number }): string {
  const tag = opts.tag ?? "@experimental";
  const reason = opts.reasonLines.map((l) => `   * ${l}`).join("\n");
  const filler = "  // filler\n".repeat(opts.filler ?? 0);
  return `import type { Hono } from "hono";

export function registerIdentityTransparencyRoutes(deps: { app: Hono; db: unknown }): void {
  const { app } = deps;

  /**
   * ${tag}
   * @since 2026-05-21
   * @stabilizes_by 2026-09-19
   * @replacement none
${reason}
   */
${filler}  app.get("/api/v1/identity/:motebitId", async (c) => {
    return c.json({ ok: true });
  });
}
`;
}

const IDENTITY_ROUTE = 'route "GET /api/v1/identity/:motebitId"';

describe("check-spec-routes annotation scanning", () => {
  beforeEach(() => {
    // Guard the guard: if a previous crash left a backup, the repo is dirty.
    expect(existsSync(`${TARGET}.gate-test-backup`)).toBe(false);
  });

  afterEach(() => {
    rmSync(`${TARGET}.gate-test-backup`, { force: true });
  });

  it("accepts a multi-paragraph @reason — comment length is not staleness", () => {
    // The exact shape from #573: a blank `*` line inside the rationale.
    const out = runGateWith(
      fixture({
        reasonLines: [
          "@reason First paragraph of the rationale.",
          "",
          "  Second paragraph — note the blank line above.",
          "",
          "  Third paragraph, to put the route well past the old 12-line budget",
          "  measured from the opening of the block.",
        ],
      }),
    );

    expect(out).not.toContain(IDENTITY_ROUTE);
    expect(out).toContain("0 unclassified");
  });

  it("still reports a route that genuinely has no annotation", () => {
    const out = runGateWith(`import type { Hono } from "hono";

export function registerIdentityTransparencyRoutes(deps: { app: Hono; db: unknown }): void {
  const { app } = deps;

  app.get("/api/v1/identity/:motebitId", async (c) => {
    return c.json({ ok: true });
  });
}
`);

    expect(out).toContain(IDENTITY_ROUTE);
    expect(out).toContain("has no @spec/@internal/@experimental annotation");
  });

  it("names an annotation that is present but too far from the route", () => {
    const out = runGateWith(fixture({ reasonLines: ["@reason Short."], filler: 14 }));

    expect(out).toContain(IDENTITY_ROUTE);
    expect(out).toContain("has an annotation at line");
    // The repair must not tell the reader to add a tag that already exists.
    expect(out).toContain("do not add a second one");
    expect(out).not.toContain("has no @spec/@internal/@experimental annotation");
  });

  it("names a JSDoc block from which no tag parsed", () => {
    const out = runGateWith(fixture({ reasonLines: ["@reason Short."], tag: "@experimentall" }));

    expect(out).toContain(IDENTITY_ROUTE);
    expect(out).toContain("no @spec/@internal/@experimental tag was parsed from it");
    expect(out).not.toContain("has no @spec/@internal/@experimental annotation");
  });
});
