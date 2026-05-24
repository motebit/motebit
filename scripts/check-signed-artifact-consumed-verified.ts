/**
 * check-signed-artifact-consumed-verified — the consumer-call complement to
 * #107 (`check-signed-artifact-verifiers`).
 *
 * #107 proves a portable verifier EXISTS for every signed `@motebit/protocol`
 * artifact. This gate proves the relay actually CALLS it. A verifier that exists
 * but is never invoked at the inbound boundary is ceremony — the
 * "require-but-not-verify" class.
 *
 * The motivating incident (2026-05-24): `services/relay/src/migration.ts`
 * accept-migration schema-validated the `CredentialBundle` (whose schema
 * *requires* a signature) but never called `verifyCredentialBundle`, and bound
 * the presented key to nothing. A stolen `MigrationToken` (spec/migration-v1.md
 * §13) presented under a thief's key would have onboarded the victim's
 * `motebit_id` under the attacker's key. Fixed in commit 077e40c1; this gate
 * locks the fix and the class.
 *
 * This is the #22→#87 relationship one layer up. #22 pins that wire SCHEMAS
 * exist; #87 (`check-wire-schema-usage`) pins they are PARSED at the boundary.
 * #107 pins that signature VERIFIERS exist; this gate pins they are CALLED.
 * Schema-parse checks shape; signature-verify checks authenticity — both are
 * required, neither substitutes for the other.
 *
 * Two rules (mirroring #87):
 *
 *   (A) Import-and-call parity. Any artifact-verifier (a function named in
 *       #107's REGISTRY as a `verifier`/`within` entry) imported from
 *       `@motebit/crypto` / `@motebit/encryption` in a `services/relay/src/*.ts`
 *       file MUST be called (`verifyX(`) in that file. Catches a refactor that
 *       drops the call but keeps the import.
 *
 *   (B) Required-usage manifest. Named relay files that consume specific inbound
 *       signed artifacts MUST import AND call the listed verifiers. Catches the
 *       stronger failure mode — a handler that consumes a signed body and never
 *       verifies it at all (the migration incident). The manifest is the audited
 *       inbound-consumer set; adding a new inbound signed-artifact handler means
 *       appending an entry here.
 *
 * Run: `tsx scripts/check-signed-artifact-consumed-verified.ts` (exit 1 on
 * violation).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRY } from "./check-signed-artifact-verifiers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICES_RELAY_SRC = resolve(ROOT, "services", "relay", "src");

/**
 * The artifact-verifier function names — the single source of truth is #107's
 * REGISTRY (`verifier` + `within` kinds). Rule A is scoped to these so the gate
 * tracks signed-protocol-artifact verification, not low-level primitives
 * (`verifyBySuite`) or auth-token checks (`verifySignedTokenForDevice`).
 */
const ARTIFACT_VERIFIERS: ReadonlySet<string> = new Set(
  Object.values(REGISTRY)
    .filter((c): c is { kind: "verifier" | "within"; verifier: string } => c.kind !== "gap")
    .map((c) => c.verifier),
);

// ── Rule B: Required-usage manifest ────────────────────────────────────
//
// Each entry: "this file consumes inbound bodies of these signed artifacts; it
// MUST import the verifier AND call it." The manifest is the audited
// inbound-consumer set (sibling of #87's REQUIRED_USAGE — same files, verifier
// instead of schema). `verifySovereignBinding` is not an artifact verifier but
// is the key↔motebit_id binding that the migration token-theft defense (§8.2
// step 6) depends on, so it is pinned here too.
const REQUIRED_USAGE: ReadonlyArray<{
  file: string;
  verifiers: ReadonlyArray<string>;
  note?: string;
}> = [
  {
    file: "services/relay/src/tasks.ts",
    verifiers: ["verifyExecutionReceipt"],
    note: "POST /tasks/:id/complete — agent-signed execution receipt",
  },
  {
    file: "services/relay/src/agents.ts",
    verifiers: ["verifyExecutionReceipt"],
    note: "POST /agents/:id/receipts — execution receipt (legacy path)",
  },
  {
    file: "services/relay/src/federation-callbacks.ts",
    verifiers: ["verifyExecutionReceipt"],
    note: "nested receipt forwarding — federation.ts schema-parses the body (#87), the callback verifies the agent signature",
  },
  {
    file: "services/relay/src/federation.ts",
    verifiers: ["verifyHorizonWitnessRequestSignature", "verifyWitnessOmissionDispute"],
    note: "peer-side co-witness signing + witness-omission dispute filing",
  },
  {
    file: "services/relay/src/migration.ts",
    verifiers: [
      "verifyMigrationToken",
      "verifyDepartureAttestation",
      "verifyCredentialBundle",
      "verifyBalanceWaiver",
      "verifySovereignBinding",
      "verifyRelayMetadata",
    ],
    note: "accept-migration (§8.2 steps 2-6: token + attestation + bundle signature + key↔id binding) + depart balance waiver + source-relay metadata tier-2 trust root",
  },
  {
    file: "services/relay/src/disputes.ts",
    verifiers: ["verifyDisputeRequest", "verifyDisputeEvidence", "verifyDisputeAppeal"],
    note: "dispute filing + evidence + appeal — client-signed inbound artifacts",
  },
  // NOTE: horizon.ts verifies peer WitnessSolicitationResponse signatures inline
  // via verifyBySuite(HORIZON_CERT_SUITE, …) against the peer's pinned key (it
  // needs the issuer-side canonical request bytes), not the portable
  // verifyHorizonWitnessRequestSignature — which it only re-exports. Verified
  // fail-closed, just below this gate's portable-verifier scope.
];

// ── Waivers ────────────────────────────────────────────────────────────
// Explicit, dated, printed every run. Empty at landing.
const WAIVERS: ReadonlyArray<{
  file: string;
  verifiers: ReadonlyArray<string>;
  reason: string;
  since: string;
}> = [];

// ── Helpers ────────────────────────────────────────────────────────────

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      out.push(...walkTs(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** Function names a file imports from `@motebit/crypto` or `@motebit/encryption`. */
function importedFns(src: string): Set<string> {
  const out = new Set<string>();
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@motebit\/(?:crypto|encryption)["']/g;
  for (const m of src.matchAll(re)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/i)[0]
        ?.trim();
      if (name) out.add(name);
    }
  }
  return out;
}

/** `verify*` / binding-check names invoked as `name(` in the file body. */
function calledFns(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\b(verify[A-Z]\w*)\s*\(/g)) if (m[1]) out.add(m[1]);
  for (const m of src.matchAll(/\b(verifySovereignBinding)\s*\(/g)) if (m[1]) out.add(m[1]);
  return out;
}

/** Names a file re-exports via `export { … }` — imported to forward, not to
 *  consume, so they are not subject to Rule A's call requirement. */
function reExportedNames(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/i)[0]
        ?.trim();
      if (name) out.add(name);
    }
  }
  return out;
}

interface Violation {
  file: string;
  kind: "import-without-call" | "manifest-missing-import" | "manifest-missing-call";
  fn: string;
  detail: string;
}

function main(): void {
  const waived = new Map<string, Set<string>>();
  for (const w of WAIVERS) waived.set(w.file, new Set(w.verifiers));

  const index = new Map<string, { imported: Set<string>; called: Set<string> }>();
  for (const abs of walkTs(SERVICES_RELAY_SRC)) {
    const rel = relative(ROOT, abs);
    const src = readFileSync(abs, "utf-8");
    // A re-exported verifier is forwarded, not consumed — drop it from the
    // imported set so Rule A does not demand a call site it shouldn't have.
    const imported = importedFns(src);
    for (const name of reExportedNames(src)) imported.delete(name);
    index.set(rel, { imported, called: calledFns(src) });
  }

  const violations: Violation[] = [];

  // Rule A — import-and-call parity, scoped to #107's artifact verifiers.
  for (const [file, { imported, called }] of index) {
    const waivedForFile = waived.get(file) ?? new Set<string>();
    for (const fn of imported) {
      if (!ARTIFACT_VERIFIERS.has(fn)) continue;
      if (waivedForFile.has(fn)) continue;
      if (!called.has(fn)) {
        violations.push({
          file,
          fn,
          kind: "import-without-call",
          detail: `imports artifact-verifier ${fn} (#107 REGISTRY) but never calls ${fn}( — a signed artifact may be consumed without verification`,
        });
      }
    }
  }

  // Rule B — required-usage manifest.
  for (const entry of REQUIRED_USAGE) {
    const state = index.get(entry.file);
    const waivedForFile = waived.get(entry.file) ?? new Set<string>();
    for (const fn of entry.verifiers) {
      if (waivedForFile.has(fn)) continue;
      if (!state) {
        violations.push({
          file: entry.file,
          fn,
          kind: "manifest-missing-import",
          detail: `manifest requires ${fn} but the file is missing from services/relay/src — update REQUIRED_USAGE`,
        });
        continue;
      }
      if (!state.imported.has(fn)) {
        violations.push({
          file: entry.file,
          fn,
          kind: "manifest-missing-import",
          detail: `manifest requires ${fn} — file does not import it from @motebit/crypto|encryption`,
        });
      } else if (!state.called.has(fn)) {
        violations.push({
          file: entry.file,
          fn,
          kind: "manifest-missing-call",
          detail: `manifest requires ${fn} — imported but never called`,
        });
      }
    }
  }

  if (WAIVERS.length > 0) {
    process.stderr.write(`signed-artifact consumer-verify waivers (${WAIVERS.length}):\n`);
    for (const w of WAIVERS) {
      process.stderr.write(`  ⚠ ${w.file} [since ${w.since}]: ${w.verifiers.join(", ")}\n`);
      process.stderr.write(`    reason: ${w.reason}\n`);
    }
  }

  process.stdout.write(
    `\n▸ check-signed-artifact-consumed-verified — every inbound signed @motebit/protocol ` +
      `artifact the relay consumes must be VERIFIED (not just schema-parsed). #107 proves the ` +
      `verifier exists; this proves it is called.\n`,
  );

  if (violations.length > 0) {
    process.stderr.write(`\n✗ check-signed-artifact-consumed-verified failed:\n`);
    let current = "";
    for (const v of violations) {
      if (v.file !== current) {
        current = v.file;
        process.stderr.write(`  [${v.file}]\n`);
      }
      process.stderr.write(`    ${v.kind}: ${v.fn} — ${v.detail}\n`);
    }
    process.stderr.write(
      `\nFix: call the verifier on the inbound body before any downstream use, fail-closed.\n`,
    );
    process.exit(1);
  }

  const required = REQUIRED_USAGE.reduce((n, e) => n + e.verifiers.length, 0);
  process.stdout.write(
    `  scanned ${index.size} relay files — ${ARTIFACT_VERIFIERS.size} artifact verifiers tracked, ` +
      `${required} required pair(s) validated.\n` +
      `✓ check-signed-artifact-consumed-verified: every consumed signed artifact is verified.\n`,
  );
}

main();
