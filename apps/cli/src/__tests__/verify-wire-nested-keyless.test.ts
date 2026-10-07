/**
 * `motebit verify receipt` must not skip a nested receipt because its key is
 * missing or malformed. A signed outer receipt whose delegation child (depth 1
 * or 2) has no / a malformed `public_key`, result "z" and result_hash =
 * sha256("y") FAILS: the child fails the signature check (it cannot be
 * verified) and the result_hash check (it does not bind its result). The
 * report never claims binding "at every delegation depth" on such a tree.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyWire } from "../subcommands/verify-wire.js";
import { nestedChain } from "./helpers/adversarial-receipts.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "motebit-verify-keyless-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("verify receipt — nested child with a missing or malformed key", () => {
  for (const how of ["missing", "malformed-short", "malformed-nonhex"] as const) {
    for (const depth of [1, 2] as const) {
      it(`${how} key at depth ${depth} → FAILS signature and result_hash`, async () => {
        const p = join(tmp, `${how}-${depth}.json`);
        writeFileSync(p, JSON.stringify(await nestedChain(depth, how)));
        const report = await verifyWire("receipt", p);
        expect(report.ok).toBe(false);
        const sig = report.checks.find((c) => c.name === "signature");
        expect(sig?.ok).toBe(false);
        expect(sig?.detail).toContain(`delegation depth ${depth}`);
        const bind = report.checks.find((c) => c.name === "result_hash");
        expect(bind?.ok).toBe(false);
        expect(bind?.detail).toContain(`delegation depth ${depth}, task_id task-depth-${depth}`);
        expect(bind?.detail).not.toMatch(/at every delegation depth/);

        const lenient = await verifyWire("receipt", p, Date.now(), { lenient: true });
        expect(lenient.ok).toBe(false);
        expect(lenient.checks.find((c) => c.name === "signature")?.ok).toBe(false);
      });
    }
  }
});
