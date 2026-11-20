/**
 * Operator token per relay — the daemon send sites, one test per row.
 *
 * The rows, the fake relays and the subprocess runner live in
 * `operator-token.probe.ts` (one self-contained file, because the
 * differential against main runs the same rows from it). Each row runs the
 * CLI from source as a subprocess against fake relays on 127.0.0.1:
 *
 *   leak     relay A's token bound to A, A in every lower-precedence relay-URL
 *            source, B named by one route: B never receives A's token and the
 *            site falls back as it does with no operator token;
 *   control  B's token bound to B: B receives it;
 *   source   one token source set alone and bound: sent exactly when the site
 *            honours that source.
 *
 * Tamper: scripts/tampers/cli-operator-token-per-relay.ts
 */
import { vi } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: nothing here reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "mb-ot-daemon-"));
  for (const k of ["MOTEBIT_SYNC_URL", "MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN", "PROBE_OUT"])
    delete process.env[k];
});

import { describe, expect, it } from "vitest";
import { defineSiteRows, selfTestRow } from "./operator-token.probe.js";

defineSiteRows("daemon");

/**
 * `motebit serve --self-test` (design section 5, 4a). NOT a leak on main:
 * self-test runs only after the daemon registered, which needs the key and
 * the device id, and with both it signs as the device. These rows hold that
 * it sends no operator token, bound or not; the differential records the same
 * on main. The self-test's token FALLBACK is unreachable and is held by
 * `check-cli-operator-token-reader` alone.
 */
describe.concurrent("serve --self-test sends no operator token (the same on main)", () => {
  for (const binding of ["unbound", "bound"] as const) {
    it(`an operator token set and ${binding}: the self-test submits as the device`, async () => {
      const o = await selfTestRow(binding);
      expect(o.requests, o.output).toBeGreaterThan(0);
      expect(o.tokenAtOwn, o.output).toEqual([]);
      expect(o.authKinds, o.output).toEqual(["device"]);
      expect(o.output).toContain("[self-test] submitting task via relay (auth: device token)");
    }, 180_000);
  }
});
