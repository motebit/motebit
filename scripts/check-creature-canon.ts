/**
 * check-creature-canon — the creature canon's static drift gate.
 *
 * Doctrine: docs/doctrine/creature-canon.md. The doc holds the rules; the
 * numbers live ONLY in packages/render-engine/src/spec.ts (CANONICAL_CAMERA,
 * CANONICAL_PERFORMANCES). This gate enforces the consumption topology:
 *
 *   1. The canon constants exist in spec.ts.
 *   2. Every camera-owning render surface (ThreeJSAdapter, mobile's
 *      creature-webview) consumes CANONICAL_CAMERA instead of re-encoding
 *      camera literals — the exact drift class that produced the mobile
 *      tone-mapping divergence (ACES@1.2 vs Neutral@1.0, hand-copied scene).
 *   3. The golden-frame matrix (apps/web/e2e/golden/golden-matrix.ts) covers
 *      every CanonicalCameraName and every PerformanceName at least once —
 *      a new pose or performance cannot land without golden coverage.
 *
 * The golden-frame harness itself (Playwright `golden` project, CI e2e job)
 * is the test-enforced sibling defense — too heavy for `pnpm check`; this
 * gate is the cheap static half.
 *
 * Exit 1 on violation. Runs in CI via pnpm check.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatRepair } from "./lib/gate-report.js";

const ROOT = resolve(import.meta.dirname, "..");

const SPEC = "packages/render-engine/src/spec.ts";
const ADAPTER = "packages/render-engine/src/adapter.ts";
const WEBVIEW = "apps/mobile/src/creature-webview.ts";
const MATRIX = "apps/web/e2e/golden/golden-matrix.ts";

// Re-encoded camera literals — the canonical front pose written out by hand
// instead of consumed from CANONICAL_CAMERA. Whitespace-flexible.
const CAMERA_LITERALS: { name: string; re: RegExp }[] = [
  { name: "position.set(0, 0.02, 0.85)", re: /position\.set\(\s*0\s*,\s*0\.02\s*,\s*0\.85\s*\)/ },
  { name: "lookAt(0, -0.015, 0)", re: /lookAt\(\s*0\s*,\s*-0\.015\s*,\s*0\s*\)/ },
  { name: "target.set(0, -0.015, 0)", re: /target\.set\(\s*0\s*,\s*-0\.015\s*,\s*0\s*\)/ },
];

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

/** Extract the quoted members of a string-literal union type declaration. */
function unionMembers(source: string, typeName: string): string[] {
  const decl = new RegExp(`export type ${typeName} =([^;]+);`).exec(source);
  if (!decl) return [];
  return [...decl[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function main(): void {
  console.log(
    "▸ check-creature-canon — canon constants exist, surfaces consume CANONICAL_CAMERA, golden matrix covers every pose × performance name",
  );

  const failures: string[] = [];

  // 1. Canon constants exist.
  const spec = read(SPEC);
  for (const constName of ["CANONICAL_CAMERA", "CANONICAL_PERFORMANCES"]) {
    if (!new RegExp(`export const ${constName}\\b`).test(spec)) {
      failures.push(
        formatRepair({
          invariant: `${SPEC} no longer exports ${constName}`,
          canonical: SPEC,
          fix: `restore the \`export const ${constName}\` declaration — the creature canon's numbers live only there`,
          doctrine: "docs/doctrine/creature-canon.md",
        }),
      );
    }
  }

  // 2. Surfaces consume the canon; no re-encoded camera literals.
  const consumers: { rel: string; token: RegExp; tokenName: string }[] = [
    { rel: ADAPTER, token: /CANONICAL_CAMERA/, tokenName: "CANONICAL_CAMERA" },
    { rel: WEBVIEW, token: /MotebitRE\.CANONICAL_CAMERA/, tokenName: "MotebitRE.CANONICAL_CAMERA" },
  ];
  for (const { rel, token, tokenName } of consumers) {
    const src = read(rel);
    if (!token.test(src)) {
      failures.push(
        formatRepair({
          invariant: `${rel} does not consume ${tokenName} — its camera is drifting from the canon`,
          canonical: SPEC,
          fix: `build the camera from ${tokenName}.front (fov / position / lookAt) instead of local literals`,
          doctrine: "docs/doctrine/creature-canon.md",
        }),
      );
    }
    for (const lit of CAMERA_LITERALS) {
      if (lit.re.test(src)) {
        failures.push(
          formatRepair({
            invariant: `${rel} re-encodes the canonical camera as a literal (${lit.name})`,
            canonical: SPEC,
            fix: `replace the literal with the corresponding CANONICAL_CAMERA.front field — the canon is the single source for camera numbers`,
            sites: [rel],
            doctrine: "docs/doctrine/creature-canon.md",
          }),
        );
      }
    }
  }

  // 3. Golden matrix exists and covers every pose and performance name.
  if (!existsSync(resolve(ROOT, MATRIX))) {
    failures.push(
      formatRepair({
        invariant: `${MATRIX} is missing — the golden-frame matrix is the proof half of the canon`,
        canonical: SPEC,
        fix: `restore ${MATRIX} exporting GOLDEN_MATRIX with ≥1 entry per CanonicalCameraName and PerformanceName`,
        doctrine: "docs/doctrine/creature-canon.md",
      }),
    );
  } else {
    const matrix = read(MATRIX);
    const cameras = unionMembers(spec, "CanonicalCameraName");
    const performances = unionMembers(spec, "PerformanceName");
    if (cameras.length === 0 || performances.length === 0) {
      failures.push(
        formatRepair({
          invariant: `could not parse CanonicalCameraName / PerformanceName unions from ${SPEC}`,
          canonical: SPEC,
          fix: "keep both unions as string-literal union type declarations so the gate can enumerate them",
          doctrine: "docs/doctrine/creature-canon.md",
        }),
      );
    }
    for (const [kind, names] of [
      ["camera pose", cameras],
      ["performance", performances],
    ] as const) {
      for (const name of names) {
        if (!new RegExp(`"${name}"`).test(matrix)) {
          failures.push(
            formatRepair({
              invariant: `canonical ${kind} "${name}" has no golden-frame coverage`,
              canonical: SPEC,
              fix: `add a GOLDEN_MATRIX entry using "${name}" to ${MATRIX} (and commit its reference frame) — a canon name cannot exist without golden coverage`,
              doctrine: "docs/doctrine/creature-canon.md",
            }),
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(f);
    console.error(`✗ check-creature-canon: ${failures.length} violation(s)`);
    process.exit(1);
  }

  console.log(
    "✓ check-creature-canon: canon constants present, both camera surfaces consume CANONICAL_CAMERA, golden matrix covers every canonical name.",
  );
}

main();
