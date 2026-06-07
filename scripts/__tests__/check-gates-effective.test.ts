/**
 * check-gates-effective — concurrent-modification detection.
 *
 * The meta-gate mutates real files in place to inject probes, so its verdict is
 * only meaningful if the injected bytes are still on disk when the gate reads
 * them. If a concurrent build / typecheck / formatter / second invocation
 * rewrites a probe target mid-run, a gate "passing" is an artifact of the race,
 * not a dead gate. Before this guard that surfaced as the misleading "one or
 * more gates failed to catch a known violation" (a real false-fail observed
 * 2026-06-07 when a `pnpm typecheck` ran alongside a push's pre-push hook).
 *
 * `findClobberedPerturbations()` is what lets the runner tell the two apart.
 * Imported directly — `main()` is guarded behind a direct-invocation check, so
 * importing the module does not execute the 120-probe run.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFixture, findClobberedPerturbations } from "../check-gates-effective.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const REL = "scripts/__tests__/__gate_probe__clobber_unit.txt";
const ABS = resolve(ROOT, REL);

let cleanup: (() => void) | null = null;
afterEach(() => {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* best-effort deregister */
    }
    cleanup = null;
  }
  if (existsSync(ABS)) unlinkSync(ABS);
});

describe("check-gates-effective — concurrent-modification detection", () => {
  it("reports no clobber when the perturbation is intact on disk", () => {
    cleanup = writeFixture(REL, "probe-bytes\n");
    expect(findClobberedPerturbations()).toEqual([]);
  });

  it("reports a clobber when the probe target is rewritten underneath the run", () => {
    cleanup = writeFixture(REL, "probe-bytes\n");
    // Simulate a concurrent writer clobbering the injected bytes.
    writeFileSync(ABS, "rewritten by a concurrent process\n");
    expect(findClobberedPerturbations()).toContain(REL);
  });

  it("reports a clobber when the probe target is deleted underneath the run", () => {
    cleanup = writeFixture(REL, "probe-bytes\n");
    unlinkSync(ABS); // deleted out from under us also counts as clobbered
    expect(findClobberedPerturbations()).toContain(REL);
  });

  it("deregisters on cleanup — a restored perturbation is no longer tracked", () => {
    const c = writeFixture(REL, "probe-bytes\n");
    c(); // probe cleaned up
    cleanup = null;
    // Even though the file is gone, it was deregistered, so it is not reported.
    expect(findClobberedPerturbations()).toEqual([]);
  });
});
