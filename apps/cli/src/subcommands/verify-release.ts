/**
 * `motebit verify-release` — the self-signing body, self-verifying.
 *
 * Hashes the RUNNING bundle's own bytes and checks them against the
 * relay's signed release witness (`/.well-known/motebit-releases.json`,
 * same envelope + same canonical verifier as the transparency
 * declaration, same key the owner pinned at `motebit register`). Closes
 * the one unverifiable claim the bundled-CLI distribution model leaves
 * open: that the artifact npm delivered is the artifact the operator
 * published from the audited tree.
 *
 * Trust chain, stated honestly: bytes-on-disk → operator's signed
 * observation of the registry → key pinned at register (TOFU +
 * optional onchain anchor). It proves the operator's word about the
 * artifact, not a reproducible build — that rung is a later arc.
 *
 * Read-only; no passphrase (verification must never require unlocking
 * the identity — a compromised binary asking for your passphrase to
 * "verify itself" would be the exact attack).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyTransparencyDeclaration } from "@motebit/state-export-client";
import { loadFullConfig } from "../config.js";
import { VERSION } from "../config.js";

interface WitnessRelease {
  version: string;
  tarball_integrity: string;
  git_head?: string;
  files: Record<string, string>;
}

export async function handleVerifyRelease(options: { bundlePath?: string } = {}): Promise<void> {
  const fullConfig = loadFullConfig();
  const relayUrl = (fullConfig.sync_url ?? "https://relay.motebit.com").replace(/\/+$/, "");
  const pinned = fullConfig.relay_public_key;

  // 1. Hash our own bytes — the running bundle.
  const bundlePath = options.bundlePath ?? process.argv[1];
  if (bundlePath == null || bundlePath === "") {
    console.error("verify-release: cannot locate the running bundle");
    process.exit(1);
  }
  let selfHash: string;
  try {
    selfHash = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
  } catch (err) {
    console.error(
      `verify-release: cannot read own bytes at ${bundlePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // 2. Fetch + verify the witness (canonical verifier — hash + Ed25519
  //    against the key the envelope carries).
  let witness: {
    relay_public_key: string;
    declared_at: number;
    content: { package: string; releases: WitnessRelease[] };
  };
  try {
    const res = await fetch(`${relayUrl}/.well-known/motebit-releases.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as Parameters<typeof verifyTransparencyDeclaration>[0];
    const verdict = await verifyTransparencyDeclaration(raw);
    if (!verdict.ok) {
      console.error(`✗ witness failed verification (${verdict.reason}) — do not trust it.`);
      process.exit(1);
    }
    witness = raw as unknown as typeof witness;
  } catch (err) {
    console.error(
      `verify-release: witness unavailable from ${relayUrl} ` +
        `(${err instanceof Error ? err.message : String(err)}). Retry online.`,
    );
    process.exit(1);
  }

  // 3. The self-signature proves integrity; the PIN proves it is YOUR
  //    operator's word. Without a pin this is TOFU — say so, honestly.
  if (pinned != null && pinned !== "" && witness.relay_public_key !== pinned) {
    console.error(
      `✗ PIN MISMATCH: witness signed by ${witness.relay_public_key.slice(0, 12)}… but your ` +
        `config pins ${pinned.slice(0, 12)}…. Do not trust this witness.`,
    );
    process.exit(1);
  }

  // 4. Compare our bytes against the witnessed release for our version.
  const release = witness.content.releases.find((r) => r.version === VERSION);
  if (release == null) {
    console.error(
      `✗ motebit@${VERSION} is not in the operator's witness ` +
        `(witnessed: ${witness.content.releases.map((r) => r.version).join(", ")}).` +
        ` A repo build or an unwitnessed version — expected for dev builds.`,
    );
    process.exit(1);
  }
  const attested = release.files["dist/index.js"];
  if (attested !== selfHash) {
    console.error(`✗ BYTES DO NOT MATCH the operator's witness for motebit@${VERSION}.`);
    console.error(`    this binary  sha256 ${selfHash}`);
    console.error(`    witnessed    sha256 ${attested ?? "(absent)"}`);
    console.error(`  Reinstall from the registry and re-run. If it persists, treat as tampering.`);
    process.exit(1);
  }

  console.log(`✓ motebit@${VERSION} — this binary's bytes match the operator's signed witness`);
  console.log(`    sha256      ${selfHash}`);
  if (release.git_head != null) console.log(`    git_head    ${release.git_head}`);
  console.log(
    `    signed by   ${witness.relay_public_key.slice(0, 12)}… ${pinned ? "(your pinned relay key)" : "(TOFU — run motebit register to pin)"}`,
  );
  console.log(`    declared    ${new Date(witness.declared_at).toISOString()}`);
}
