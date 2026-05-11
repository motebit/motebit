#!/usr/bin/env tsx
/**
 * check-transparency-onchain-anchored — closes the savant gap by
 * structurally requiring the relay to anchor its transparency
 * declaration onchain whenever a Solana submitter is configured.
 *
 * Doctrine: `docs/doctrine/operator-transparency.md` § "Stage 2 onchain
 * anchor"; `docs/doctrine/nist-alignment.md` §8 "savant gap closure".
 *
 * The trust-on-first-use (TOFU) bootstrap on
 * `/.well-known/motebit-transparency.json` trusts HTTPS + DNS + CAs for
 * the first fetch. Without an onchain anchor, a verifier can be MITM'd
 * to accept an attacker-substituted declaration whose self-signature
 * verifies (against the attacker's key). With an anchor, the verifier
 * cross-checks the declaration's hash against a Solana memo at the
 * relay's pinned anchor address — a second channel that the network
 * provider cannot tamper with.
 *
 * This gate makes the producer side load-bearing: in the relay startup
 * file, every code path that constructs a `SolanaMemoSubmitter` MUST
 * also wire `anchorTransparencyDeclaration` so the declaration's hash
 * is committed onchain. Forgetting the second call leaves the savant
 * gap open silently.
 *
 * Forbidden: a relay startup that creates `createSolanaMemoSubmitter`
 * without a corresponding `anchorTransparencyDeclaration` call.
 *
 * Scope: `services/relay/src/index.ts` only. The gate is narrow on
 * purpose — Solana submitters constructed elsewhere (tests, scripts)
 * are not the trust-anchor surface and should not be forced to anchor
 * the declaration. If future relay code splits startup wiring across
 * files, the SCAN_FILES set below grows.
 *
 * Usage:
 *   tsx scripts/check-transparency-onchain-anchored.ts        # exit 1 on violation
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const SCAN_FILES = ["services/relay/src/index.ts"];

const SUBMITTER_PATTERN = /\bcreateSolanaMemoSubmitter\s*\(/g;
const ANCHOR_PATTERN = /\banchorTransparencyDeclaration\s*\(/g;

interface Finding {
  file: string;
  reason: string;
}

function main(): void {
  const findings: Finding[] = [];

  for (const rel of SCAN_FILES) {
    const abs = resolve(REPO_ROOT, rel);
    let src: string;
    try {
      src = readFileSync(abs, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        file: rel,
        reason: `cannot read file (${msg})`,
      });
      continue;
    }

    SUBMITTER_PATTERN.lastIndex = 0;
    const submitterMatches = [...src.matchAll(SUBMITTER_PATTERN)];
    ANCHOR_PATTERN.lastIndex = 0;
    const anchorMatches = [...src.matchAll(ANCHOR_PATTERN)];

    if (submitterMatches.length === 0) {
      // No Solana wiring in this file at all. The savant gap doesn't
      // apply (no anchor channel available, so TOFU is the only
      // option). The doctrine acknowledges this as the dev/testnet
      // state — declared in transparency.json's `honest_gaps`. No
      // violation.
      continue;
    }

    if (anchorMatches.length === 0) {
      findings.push({
        file: rel,
        reason: `creates createSolanaMemoSubmitter (${submitterMatches.length} call(s)) but does NOT call anchorTransparencyDeclaration anywhere in the file — the transparency declaration goes unanchored, leaving the TOFU/savant gap open`,
      });
    }
  }

  console.log(
    `check-transparency-onchain-anchored — scanned ${SCAN_FILES.length} relay startup file(s)\n`,
  );

  if (findings.length === 0) {
    console.log(
      `✓ Every relay startup that constructs a Solana memo submitter also anchors the transparency declaration onchain.`,
    );
    return;
  }

  console.log(`✗ Transparency anchoring missing:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}`);
    console.log(`    ${f.reason}`);
  }
  console.log(
    `\n  Fix: after createSolanaMemoSubmitter constructs the submitter,\n` +
      `       call anchorTransparencyDeclaration with the same submitter so\n` +
      `       the declaration's hash is committed onchain:\n` +
      `\n` +
      `         const { buildSignedDeclaration, anchorTransparencyDeclaration } =\n` +
      `           await import("./transparency.js");\n` +
      `         const declaration = await buildSignedDeclaration(relayIdentity);\n` +
      `         await anchorTransparencyDeclaration(declaration, memoSubmitter);\n` +
      `\n` +
      `       Closes the trust-on-first-use savant gap: a verifier with the\n` +
      `       relay's pinned anchor address can cross-check the declaration\n` +
      `       hash against the onchain memo without trusting HTTPS/DNS for\n` +
      `       the first contact. Fire-and-forget at the relay; anchor failure\n` +
      `       must NOT block startup.\n` +
      `\n` +
      `       Doctrine: docs/doctrine/operator-transparency.md § Stage 2,\n` +
      `       docs/doctrine/nist-alignment.md §8.\n`,
  );
  process.exit(1);
}

main();
