/**
 * The committed legacy vector (a receipt signed before producers repaired
 * unpaired surrogates — strict-negative/result-lone-surrogate.json): both
 * receipt CLIs reject it under the strict default with the §11.4 reason as a
 * result_hash failure (its signature verifies), and accept it under --lenient,
 * matching the runtime's and relay's signature checks.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..");
const VECTOR = join(
  REPO,
  "examples/python-receipt-verifier/fixtures/strict-negative/result-lone-surrogate.json",
);
const WIRE = resolve(HERE, "helpers", "run-verify-wire.ts");
const MOTEBIT_VERIFY = join(REPO, "packages", "verify", "src", "cli.ts");
const REASON =
  "§11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — it has no UTF-8 encoding";

function run(script: string, args: readonly string[]) {
  const r = spawnSync("npx", ["--yes", "tsx", script, ...args], {
    cwd: REPO,
    encoding: "utf-8",
    timeout: 120_000,
  });
  // eslint-disable-next-line no-control-regex -- strip ANSI colour codes
  const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  return { status: r.status, out };
}

describe("legacy lone-surrogate receipt — strict rejects with §11.4, --lenient accepts", () => {
  it("motebit verify receipt", () => {
    const strict = run(WIRE, ["receipt", VECTOR]);
    expect(strict.status).toBe(1);
    expect(strict.out).toMatch(/✓ signature/);
    expect(strict.out).toContain(`✗ result_hash ${REASON}`);
    const lenient = run(WIRE, ["receipt", VECTOR, "--lenient"]);
    expect(lenient.status).toBe(0);
  }, 300_000);

  it("motebit-verify", () => {
    const strict = run(MOTEBIT_VERIFY, [VECTOR]);
    expect(strict.status).toBe(1);
    expect(strict.out).toContain(REASON);
    const lenient = run(MOTEBIT_VERIFY, ["--lenient", VECTOR]);
    expect(lenient.status).toBe(0);
    expect(lenient.out).toMatch(/VALID \(receipt\)/);
  }, 300_000);
});
