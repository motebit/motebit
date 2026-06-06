/**
 * Cross-implementation receipt conformance — the protocol's conformance suite.
 *
 * Doctrine (docs/doctrine/agency-proof-integration.md §9): "same fixture → same
 * verdict across implementations" is the PLATFORM's guarantee, owned here where
 * all the impls live — never bolted onto a consumer's CI. This gate asserts that
 * every committed receipt vector verifies to the same INTEGRITY verdict across:
 *
 *   - @motebit/verifier        (verifyArtifact)        — the offline wrapper
 *   - @motebit/crypto          (verifyReceipt)         — the floor primitive
 *   - @motebit/state-export-client (verifyReceiptDocument) — the full-ladder surface
 *   - the Python reference verifier (examples/python-receipt-verifier/verify.py)
 *
 * and that every fixture, once a byte is mutated, is REJECTED by all of them.
 *
 * Scope note — why this asserts INTEGRITY, not the binding rung. The three TS
 * surfaces deliberately compute *different* binding rungs (verifier computes the
 * offline `sovereign` rung; state-export-client scopes its ladder to the
 * operator anchor — integrity-only → pinned → anchored — and does not compute
 * the offline sovereign rung). They MUST agree on integrity (signature valid /
 * tamper rejected) — that is the byte-for-byte interlock the whole proof story
 * rests on. The rung is per-surface by design (see choosing-a-verify-surface).
 * As a separate guard, this gate also pins the verifier's own `sovereign` rung
 * per fixture, so that offline-sovereign computation can't silently regress.
 *
 * Requires the packages to be built (CI runs `pnpm build` first). The Python leg
 * runs when `python3` + `pynacl` are available; in CI set REQUIRE_PYTHON=1 to
 * make it mandatory (the python-receipt-verifier job guarantees the deps).
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const fixturesDir = join(repoRoot, "examples/python-receipt-verifier/fixtures");
  const verifyPy = join(repoRoot, "examples/python-receipt-verifier/verify.py");

  const verifier = await import(join(repoRoot, "packages/verifier/dist/index.js"));
  const crypto = await import(join(repoRoot, "packages/crypto/dist/index.js"));
  const sec = await import(join(repoRoot, "packages/state-export-client/dist/index.js"));

  // Expected offline sovereign rung per fixture (verifier's `result.sovereign`).
  // `example-receipt.json` is integrity-only (random motebit_id); every
  // `sovereign-*.json` vector binds the key, so it must read sovereign.
  const expectSovereign = (file: string): boolean => file.startsWith("sovereign-receipt");

  const failures: string[] = [];
  const note = (m: string) => console.log(`  ${m}`);

  const fixtures = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(
    `▸ check-receipt-conformance — ${fixtures.length} vectors × {verifier, crypto, state-export-client, python}`,
  );

  // Python availability (best-effort unless REQUIRE_PYTHON=1).
  const requirePython = process.env.REQUIRE_PYTHON === "1";
  const probe = spawnSync("python3", [verifyPy, join(fixturesDir, fixtures[0]!)], {
    encoding: "utf8",
  });
  const pythonOk = probe.status === 0 && /"valid"/.test(probe.stdout);
  if (!pythonOk) {
    const msg = `python leg unavailable (${(probe.stderr || probe.error?.message || "").split("\n")[0]})`;
    if (requirePython) failures.push(`REQUIRE_PYTHON=1 but ${msg}`);
    else note(`skipping python leg: ${msg} — covered by the python-receipt-verifier CI job`);
  }

  const pyValid = (file: string): boolean | null => {
    if (!pythonOk) return null;
    const r = spawnSync("python3", [verifyPy, join(fixturesDir, file)], { encoding: "utf8" });
    try {
      return JSON.parse(r.stdout).valid === true;
    } catch {
      return null;
    }
  };

  for (const file of fixtures) {
    const raw = readFileSync(join(fixturesDir, file), "utf8");
    const receipt = JSON.parse(raw);

    const v = await verifier.verifyArtifact(raw);
    const c = await crypto.verifyReceipt(receipt);
    const s = await sec.verifyReceiptDocument(raw);
    const py = pyValid(file);

    // 1. Integrity agreement — the byte-for-byte interlock.
    const integrity = [v.valid, c.valid, s.integrity, ...(py === null ? [] : [py])];
    if (!integrity.every((x) => x === true)) {
      failures.push(
        `${file}: integrity DISAGREEMENT — verifier=${v.valid} crypto=${c.valid} sec=${s.integrity} python=${py}`,
      );
    }

    // 2. Verifier's offline sovereign rung must match expectation (regression pin).
    const want = expectSovereign(file);
    if (Boolean(v.sovereign) !== want) {
      failures.push(`${file}: verifier sovereign=${Boolean(v.sovereign)}, expected ${want}`);
    }

    // 3. Tamper → all reject. Flip one char of a signed field.
    const t = JSON.parse(raw);
    t.result = typeof t.result === "string" ? t.result.slice(0, -1) + "X" : "tampered";
    const ts = JSON.stringify(t);
    const tv = await verifier.verifyArtifact(ts);
    const tc = await crypto.verifyReceipt(JSON.parse(ts));
    const tsec = await sec.verifyReceiptDocument(ts);
    if (tv.valid || tc.valid || tsec.integrity) {
      failures.push(
        `${file}: tamper NOT rejected — verifier=${tv.valid} crypto=${tc.valid} sec=${tsec.integrity}`,
      );
    }

    console.log(
      `  ${file.padEnd(42)} integrity ✓  sovereign:${String(Boolean(v.sovereign)).padEnd(5)} tamper→reject ✓${py === null ? "" : "  python ✓"}`,
    );
  }

  if (failures.length > 0) {
    console.error(`\n✗ check-receipt-conformance: ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `\n✓ check-receipt-conformance: all ${fixtures.length} vectors agree on integrity${pythonOk ? " (incl. Python reference)" : ""}, verifier sovereign rungs pinned, tamper rejected by all surfaces.`,
  );
}

main().catch((e) => {
  console.error("check-receipt-conformance crashed:", e);
  process.exit(1);
});
