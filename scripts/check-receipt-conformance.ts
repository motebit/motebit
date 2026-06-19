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
 * What this asserts. (1) INTEGRITY agreement — every surface returns the same
 * valid/invalid verdict, and all reject a tampered byte; that is the
 * byte-for-byte interlock the whole proof story rests on. (2) OFFLINE SOVEREIGN
 * RUNG agreement — `@motebit/verifier`'s `result.sovereign` and
 * `@motebit/state-export-client`'s offline `binding === "sovereign"` must match
 * per fixture. Both compute it through the same `@motebit/crypto`
 * `verifySovereignBinding` primitive, so a divergence means one wrapper drifted
 * (the gap this gate originally surfaced; closed once both compute it). The
 * relay-only rungs (`pinned`/`anchored`) need material and are not exercised here.
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
  // `example-receipt.json` is the one integrity-only vector (random motebit_id,
  // not key-committed); EVERY other ExecutionReceipt fixture here binds the key
  // (sovereign-receipt*, triad-*), so it must read sovereign. Expectation is
  // "sovereign unless it's the known integrity-only fixture" — named-allowlist
  // would silently expect the wrong rung for a future sovereign vector.
  const INTEGRITY_ONLY = new Set(["example-receipt.json"]);
  const expectSovereign = (file: string): boolean => !INTEGRITY_ONLY.has(file);

  const failures: string[] = [];
  const note = (m: string) => console.log(`  ${m}`);

  // Scope to ExecutionReceipt fixtures only — this gate checks cross-impl
  // RECEIPT conformance. The fixtures dir also holds other signed-artifact
  // vectors: ApprovalDecisions (`approval_id` + `verdict`, no `task_id`) and
  // ToolInvocationReceipts (`invocation_id` + `args_hash`, no `tools_used`),
  // each verified by its own primitive — not the ExecutionReceipt verifiers
  // swept here. Shape-detect on the markers UNIQUE to ExecutionReceipt
  // (`task_id` + the `tools_used` array — ToolInvocationReceipt has neither
  // `tools_used` nor an absent `invocation_id`) rather than name-match, so a
  // future non-receipt fixture can't silently re-break this gate.
  const isReceiptFixture = (f: string): boolean => {
    if (!f.endsWith(".json")) return false;
    try {
      const o = JSON.parse(readFileSync(join(fixturesDir, f), "utf8")) as Record<string, unknown>;
      return (
        typeof o.task_id === "string" &&
        Array.isArray(o.tools_used) &&
        o.invocation_id === undefined
      );
    } catch {
      return false;
    }
  };
  const allJson = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
  const fixtures = allJson.filter(isReceiptFixture).sort();
  const skipped = allJson.length - fixtures.length;

  console.log(
    `▸ check-receipt-conformance — ${fixtures.length} receipt vectors × {verifier, crypto, state-export-client, python}` +
      (skipped > 0
        ? ` (${skipped} non-receipt fixture(s) excluded — verified by their own primitives)`
        : ""),
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

    // 2b. state-export-client's offline sovereign rung must AGREE with verifier's
    // (both route through @motebit/crypto's verifySovereignBinding — a mismatch
    // means one wrapper reimplemented or skipped the rung).
    if ((s.binding === "sovereign") !== Boolean(v.sovereign)) {
      failures.push(
        `${file}: offline sovereign-rung DISAGREEMENT — verifier=${Boolean(v.sovereign)} state-export-client.binding=${s.binding}`,
      );
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
    console.error(
      "\nFix: all four surfaces verify the SAME canonical recipe (JCS → SHA-256 → Ed25519 →\n" +
        "     suite-dispatch); a per-fixture disagreement means one wrapper drifted from it.\n" +
        "     The `verifier=`/`crypto=`/`sec=`/`python=` flags name which surface dissented —\n" +
        "     the odd one out is the drifted implementation:\n" +
        "       • verifier  → packages/verifier/src/index.ts\n" +
        "       • crypto    → packages/crypto/src/artifacts.ts (verifyExecutionReceipt / verifySovereignBinding)\n" +
        "       • sec       → packages/state-export-client/src/receipt-document.ts\n" +
        "       • python    → python/ reference verifier\n" +
        "     Re-align the dissenting surface to @motebit/crypto's canonical primitive; never\n" +
        "     loosen a fixture to make a tamper-NOT-rejected failure pass.",
    );
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
