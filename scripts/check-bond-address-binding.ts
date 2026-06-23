#!/usr/bin/env tsx
/**
 * check-bond-address-binding — locks the load-bearing anti-sybil invariant of
 * the commitment bond: a `BondCommitment` is valid ONLY if its `bonded_address`
 * is the agent's OWN sovereign identity address — `base58btc(bonded_public_key)`
 * (the Solana address derivation).
 *
 * This is the whole justification for the bond as an anti-sybil signal. Without
 * it, one wallet can back unlimited identities (post one bond, claim it backs
 * thousands of fakes) and the bond is anti-nothing. The enforcement lives inside
 * `@motebit/crypto`'s `verifyBondCommitment`, so a single deleted line would
 * silently turn the bond from a per-identity costly signal into free
 * decoration. This gate makes that deletion a CI failure.
 *
 * Three arms:
 *
 *   1. **The binding subject exists.** `BondCommitment`
 *      (`packages/protocol/src/bond.ts`) declares both `bonded_address` and
 *      `bonded_public_key` — the two fields the binding relates.
 *
 *   2. **The verifier enforces the binding (the load-bearing scan).**
 *      `verifyBondCommitment`'s body (`packages/crypto/src/artifacts.ts`) must
 *      compare `bonded_address` against `base58btcEncode(...)` and `return false`
 *      on mismatch — fail-closed. The address derivation MUST be re-checked
 *      inside the verifier, never trusted from the wire.
 *
 *   3. **The law is specced.** `spec/bond-v1.md` states the binding as
 *      foundation law (`bonded_address == base58btc(bonded_public_key)`), so an
 *      independent implementer enforces the same rule.
 *
 * Doctrine: `docs/doctrine/commitment-bond.md`.
 * This is a synchronization-invariant defense; see docs/drift-defenses.md.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BOND_TS = "packages/protocol/src/bond.ts";
const ARTIFACTS_TS = "packages/crypto/src/artifacts.ts";
const SPEC_MD = "spec/bond-v1.md";

function read(rel: string): string | null {
  const abs = resolve(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** Extract a function body from its `export ... function NAME(` to the next top-level `export`. */
function functionBlock(src: string, name: string): string | null {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const rest = src.slice(start);
  const nextExport = rest.indexOf("\nexport ");
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

const findings: string[] = [];

// ── Arm 1: the binding subject exists on the type ─────────────────────────
const bondSrc = read(BOND_TS);
if (bondSrc === null) {
  findings.push(`${BOND_TS}: missing — the BondCommitment type must define the bond artifact.`);
} else {
  for (const field of ["bonded_address", "bonded_public_key"]) {
    if (!new RegExp(`\\b${field}\\b`).test(bondSrc)) {
      findings.push(
        `${BOND_TS}: BondCommitment does not declare \`${field}\` — the anti-sybil binding relates bonded_address to bonded_public_key; both must exist.`,
      );
    }
  }
}

// ── Arm 2: the verifier enforces the binding, fail-closed (load-bearing) ───
const artifactsSrc = read(ARTIFACTS_TS);
if (artifactsSrc === null) {
  findings.push(
    `${ARTIFACTS_TS}: missing — verifyBondCommitment must enforce the address binding.`,
  );
} else {
  const block = functionBlock(artifactsSrc, "verifyBondCommitment");
  if (block === null) {
    findings.push(
      `${ARTIFACTS_TS}: verifyBondCommitment not found — the verifier that enforces the binding is gone.`,
    );
  } else {
    const comparesAddress = /bonded_address\s*!==\s*base58btcEncode\(/.test(block);
    const rejects = /return false/.test(block);
    if (!comparesAddress || !rejects) {
      findings.push(
        `${ARTIFACTS_TS}: verifyBondCommitment must reject (\`return false\`) when ` +
          `\`commitment.bonded_address !== base58btcEncode(bonded_public_key bytes)\` — ` +
          `the anti-sybil address binding. Found compare=${comparesAddress}, reject=${rejects}. ` +
          `Re-check the Solana address derivation inside the verifier; never trust bonded_address from the wire.`,
      );
    }
  }
}

// ── Arm 3: the law is specced for independent implementers ────────────────
const specSrc = read(SPEC_MD);
if (specSrc === null) {
  findings.push(`${SPEC_MD}: missing — the binding must be foundation law for interop.`);
} else if (!/bonded_address\s*==\s*base58btc\(bonded_public_key\)/.test(specSrc)) {
  findings.push(
    `${SPEC_MD}: must state the binding as foundation law (\`bonded_address == base58btc(bonded_public_key)\`) so an independent verifier enforces the same anti-sybil rule.`,
  );
}

// ── Report ─────────────────────────────────────────────────────────────────
if (findings.length > 0) {
  failWithRepair({
    invariant:
      "A BondCommitment is valid only if bonded_address == base58btc(bonded_public_key) — the anti-sybil binding that stops one wallet backing many identities.",
    canonical: `${ARTIFACTS_TS} (verifyBondCommitment) + ${BOND_TS} (BondCommitment) + ${SPEC_MD} §2`,
    fix: "Restore the fail-closed binding check in verifyBondCommitment (reject when bonded_address !== base58btcEncode(bonded_public_key bytes)); keep both fields on the type and the §2 foundation law in the spec.",
    sites: findings,
    doctrine: "docs/doctrine/commitment-bond.md",
  });
}

console.log(
  "✓ check-bond-address-binding: BondCommitment binds bonded_address to bonded_public_key, verifyBondCommitment enforces it fail-closed, and spec/bond-v1.md §2 states the law.",
);
