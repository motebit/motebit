/**
 * A guardian named only by the artifact being verified is NOT a trust root.
 *
 * Rule: a guardian supplied only by the presented identity file may be checked
 * for signature integrity, but can never establish authority. A guardian-
 * recovery link (spec/identity-v1.md §3.8.3) counts toward a `bound` or
 * `sovereign` verdict only when the guardian key comes from the CALLER — the
 * explicit `guardianPublicKeyHex` / `trustedGuardianPublicKeyHex` parameter.
 *
 * The attack these tests pin (reproduced by execution before the fix): an
 * attacker who knows ONLY a victim's genesis PUBLIC key K0 mints a guardian
 * G_att and a key K_att, signs a guardian-recovery link K0 → K_att with G_att,
 * and presents a file with `motebit_id = deriveSovereignMotebitId(K0)`,
 * `public_key = K_att`, `guardian.public_key = G_att`. Before the fix every
 * binding primitive read that file-named guardian and answered `sovereign`.
 *
 * Every assertion goes through the PUBLIC API with the plain, existing call
 * signatures, starting from no victim secret.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  deriveSovereignMotebitId,
  signGuardianRecoverySuccession,
  signKeySuccession,
  verifyKeyBindingAtTime,
  verifyMigratingKeyBinding,
  verifyIdentityBindingAnchored,
  identityLogLeaf,
  canonicalJson,
  signBySuite,
  type KeyPair,
  type MotebitIdentityFile,
  type SuccessionRecord,
} from "../index.js";

const DAY = 24 * 60 * 60 * 1000;
const SUITE = "motebit-jcs-ed25519-hex-v1" as const;

function identityFile(
  motebitId: string,
  currentKeyHex: string,
  succession: SuccessionRecord[],
  guardianKeyHex: string | undefined,
  createdAtMs: number,
): MotebitIdentityFile {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date(createdAtMs).toISOString(),
    owner_id: "owner",
    identity: { algorithm: "Ed25519", public_key: currentKeyHex },
    ...(guardianKeyHex !== undefined
      ? {
          guardian: {
            public_key: guardianKeyHex,
            established_at: new Date(createdAtMs).toISOString(),
          },
        }
      : {}),
    governance: {
      trust_mode: "guarded",
      max_risk_auto: "0",
      require_approval_above: "0",
      deny_above: "0",
      operator_mode: false,
    },
    privacy: { default_sensitivity: "none", retention_days: {}, fail_closed: true },
    memory: { half_life_days: 30, confidence_threshold: 0.5, per_turn_limit: 5 },
    devices: [],
    succession,
  } as MotebitIdentityFile;
}

describe("forged file-named guardian (attacker knows only the victim's genesis PUBLIC key)", () => {
  let victimGenesisHex: string;
  let victimId: string;
  let gAtt: KeyPair;
  let kAtt: KeyPair;
  let kAttHex: string;
  let attackFile: MotebitIdentityFile;
  let now: number;

  beforeAll(async () => {
    const victim = await generateKeypair(); // only .publicKey is used below
    victimGenesisHex = bytesToHex(victim.publicKey);
    victimId = await deriveSovereignMotebitId(victimGenesisHex);
    gAtt = await generateKeypair();
    kAtt = await generateKeypair();
    kAttHex = bytesToHex(kAtt.publicKey);
    const link = await signGuardianRecoverySuccession(
      gAtt.privateKey,
      kAtt.privateKey,
      victim.publicKey,
      kAtt.publicKey,
    );
    now = link.timestamp + 1_000;
    attackFile = identityFile(
      victimId,
      kAttHex,
      [link as unknown as SuccessionRecord],
      bytesToHex(gAtt.publicKey),
      link.timestamp - DAY,
    );
  });

  it("verifyKeyBindingAtTime (plain 3-arg call) does NOT bind and is NOT sovereign", async () => {
    const r = await verifyKeyBindingAtTime(attackFile, kAttHex, now);
    expect(r.bound).toBe(false);
    expect(r.sovereign).not.toBe(true);
  });

  it("verifyMigratingKeyBinding (the relay's exact 3-arg call shape) refuses the attack file", async () => {
    expect(await verifyMigratingKeyBinding(victimId, kAttHex, attackFile)).toBe(false);
  });

  it("verifyIdentityBindingAnchored (no guardian param) refuses the attack file, even with a valid inclusion proof", async () => {
    // A real single-leaf log over (victim id, attacker key): the inclusion half
    // holds, so only the guardian rule stands between the attacker and `bound`.
    const root = await identityLogLeaf(victimId, kAttHex);
    const proof = { index: 0, siblings: [], layerSizes: [1], anchoredRoot: root };
    const r = await verifyIdentityBindingAnchored(attackFile, kAttHex, now, proof);
    expect(r.bound).toBe(false);
    expect(r.sovereign).not.toBe(true);
  });

  it("reports the four properties separately: integrity valid, guardian authority NOT established", async () => {
    const r = await verifyKeyBindingAtTime(attackFile, kAttHex, now);
    // Genesis commitment is a true FACT about the file (the id commits to K0),
    // and it is public knowledge — it confers nothing on its own.
    expect(r.genesisCommitment).toBe(true);
    expect(r.genesisPublicKey).toBe(victimGenesisHex);
    // The link's signatures are internally consistent under the file's guardian…
    expect(r.successionIntegrity).toBe(true);
    // …but that guardian was named only by the presented file.
    expect(r.guardianAuthority).toBe("not_established");
    expect(r.reason).toMatch(/guardian/i);
  });

  it("the presented file's guardian never substitutes for a caller-trusted one that disagrees", async () => {
    const realGuardian = bytesToHex((await generateKeypair()).publicKey);
    const r = await verifyKeyBindingAtTime(attackFile, kAttHex, now, realGuardian);
    expect(r.bound).toBe(false);
    expect(r.successionIntegrity).toBe(false);
    expect(await verifyMigratingKeyBinding(victimId, kAttHex, attackFile, realGuardian)).toBe(
      false,
    );
  });

  it("the trusted parameter is a TRUST DECISION: copying the file's own guardian into it re-opens the hole", async () => {
    // Documented hazard, not a feature: a caller who passes the guardian it read
    // out of the same presented file has trusted the attacker. No in-repo
    // consumer does this (see docs/doctrine/identity-binding-verification.md).
    const copied = attackFile.guardian!.public_key;
    const r = await verifyKeyBindingAtTime(attackFile, kAttHex, now, copied);
    expect(r.bound).toBe(true);
    expect(r.guardianAuthority).toBe("caller_trusted");
  });
});

describe("legitimate chains through the same primitives", () => {
  let genesis: KeyPair;
  let rotated: KeyPair;
  let recovered: KeyPair;
  let guardian: KeyPair;
  let gHex: string;
  let sid: string;

  beforeAll(async () => {
    genesis = await generateKeypair();
    rotated = await generateKeypair();
    recovered = await generateKeypair();
    guardian = await generateKeypair();
    gHex = bytesToHex(guardian.publicKey);
    sid = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
  });

  it("ordinary rotation (no guardian anywhere) is unchanged: bound + sovereign, guardian not required", async () => {
    const link = await signKeySuccession(
      genesis.privateKey,
      rotated.privateKey,
      rotated.publicKey,
      genesis.publicKey,
    );
    const file = identityFile(
      sid,
      bytesToHex(rotated.publicKey),
      [link as unknown as SuccessionRecord],
      undefined,
      link.timestamp - DAY,
    );
    const r = await verifyKeyBindingAtTime(file, bytesToHex(rotated.publicKey), link.timestamp + 1);
    expect(r.bound).toBe(true);
    expect(r.sovereign).toBe(true);
    expect(r.genesisCommitment).toBe(true);
    expect(r.successionIntegrity).toBe(true);
    expect(r.guardianAuthority).toBe("not_required");
    expect(await verifyMigratingKeyBinding(sid, bytesToHex(rotated.publicKey), file)).toBe(true);
  });

  it("ordinary rotation with a guardian in the file still binds (the guardian is never consulted)", async () => {
    const link = await signKeySuccession(
      genesis.privateKey,
      rotated.privateKey,
      rotated.publicKey,
      genesis.publicKey,
    );
    const file = identityFile(
      sid,
      bytesToHex(rotated.publicKey),
      [link as unknown as SuccessionRecord],
      gHex,
      link.timestamp - DAY,
    );
    const r = await verifyKeyBindingAtTime(file, bytesToHex(rotated.publicKey), link.timestamp + 1);
    expect(r.bound).toBe(true);
    expect(r.sovereign).toBe(true);
  });

  it("legitimate guardian recovery binds ONLY for a caller who supplies the guardian", async () => {
    const link = await signGuardianRecoverySuccession(
      guardian.privateKey,
      recovered.privateKey,
      genesis.publicKey,
      recovered.publicKey,
    );
    const file = identityFile(
      sid,
      bytesToHex(recovered.publicKey),
      [link as unknown as SuccessionRecord],
      gHex,
      link.timestamp - DAY,
    );
    const kRec = bytesToHex(recovered.publicKey);
    const at = link.timestamp + 1;

    // Caller-trusted guardian ⇒ bound + sovereign, unchanged from before.
    const trusted = await verifyKeyBindingAtTime(file, kRec, at, gHex);
    expect(trusted.bound).toBe(true);
    expect(trusted.sovereign).toBe(true);
    expect(trusted.guardianAuthority).toBe("caller_trusted");
    expect(await verifyMigratingKeyBinding(sid, kRec, file, gHex)).toBe(true);

    // Same legitimate file, no caller guardian ⇒ NOT bound (the honest downgrade).
    const untrusted = await verifyKeyBindingAtTime(file, kRec, at);
    expect(untrusted.bound).toBe(false);
    expect(untrusted.successionIntegrity).toBe(true);
    expect(untrusted.guardianAuthority).toBe("not_established");
    expect(await verifyMigratingKeyBinding(sid, kRec, file)).toBe(false);

    // Pre-recovery receipts by the genesis key: with the trusted guardian they
    // bind in the genesis window; without it the chain as a whole is not
    // established, so they do not bind through the file either.
    const before = link.timestamp - 1;
    const kGen = bytesToHex(genesis.publicKey);
    expect((await verifyKeyBindingAtTime(file, kGen, before, gHex)).bound).toBe(true);
    expect((await verifyKeyBindingAtTime(file, kGen, before)).bound).toBe(false);
  });

  it("a never-rotated identity is unaffected (no chain, no guardian question)", async () => {
    const kGen = bytesToHex(genesis.publicKey);
    const file = identityFile(sid, kGen, [], gHex, Date.now() - DAY);
    const r = await verifyKeyBindingAtTime(file, kGen, Date.now());
    expect(r.bound).toBe(true);
    expect(r.sovereign).toBe(true);
    expect(r.guardianAuthority).toBe("not_required");
    expect(r.successionIntegrity).toBeUndefined();
  });

  it("null, empty or malformed trusted guardian is NOT supplied: not_established, never caller_trusted", async () => {
    const link = await signGuardianRecoverySuccession(
      guardian.privateKey,
      recovered.privateKey,
      genesis.publicKey,
      recovered.publicKey,
    );
    const file = identityFile(
      sid,
      bytesToHex(recovered.publicKey),
      [link as unknown as SuccessionRecord],
      gHex,
      link.timestamp - DAY,
    );
    const kRec = bytesToHex(recovered.publicKey);
    const at = link.timestamp + 1;
    const bad: unknown[] = [null, "", "zz".repeat(32), gHex.slice(0, 62), `${gHex}00`, 42];
    for (const value of bad) {
      const r = await verifyKeyBindingAtTime(file, kRec, at, value as string);
      expect(r.bound).toBe(false);
      expect(r.guardianAuthority).toBe("not_established");
      expect(await verifyMigratingKeyBinding(sid, kRec, file, value as string)).toBe(false);
    }
  });

  it("prefix keys of a recovered chain (genesis→k1 ordinary→k3 recovery) do not bind without a trusted guardian", async () => {
    const T0 = Date.parse("2026-01-01T00:00:00Z");
    const T1 = Date.parse("2026-02-01T00:00:00Z");
    const T2 = Date.parse("2026-03-01T00:00:00Z");
    const k1 = rotated;
    const k3 = recovered;
    const file = identityFile(
      sid,
      bytesToHex(k3.publicKey),
      [await ordinaryLinkAt(genesis, k1, T1), await recoveryLinkAt(k1, k3, guardian, T2)],
      gHex,
      T0,
    );
    const k1Hex = bytesToHex(k1.publicKey);
    const kGen = bytesToHex(genesis.publicKey);

    // With the caller-trusted guardian: k1 binds (sovereign) inside its window.
    const trusted = await verifyKeyBindingAtTime(file, k1Hex, T1 + DAY, gHex);
    expect(trusted.bound).toBe(true);
    expect(trusted.sovereign).toBe(true);

    // Without it: k1 BEFORE the recovery no longer binds (was bound+sovereign
    // through the file's guardian), and neither does the genesis key.
    const k1FileOnly = await verifyKeyBindingAtTime(file, k1Hex, T1 + DAY);
    expect(k1FileOnly.bound).toBe(false);
    expect(k1FileOnly.guardianAuthority).toBe("not_established");
    expect(k1FileOnly.successionIntegrity).toBe(true);
    expect((await verifyKeyBindingAtTime(file, kGen, T0 + DAY)).bound).toBe(false);
  });
});

async function ordinaryLinkAt(
  oldKp: KeyPair,
  newKp: KeyPair,
  timestamp: number,
): Promise<SuccessionRecord> {
  const old_public_key = bytesToHex(oldKp.publicKey);
  const new_public_key = bytesToHex(newKp.publicKey);
  const msg = new TextEncoder().encode(
    canonicalJson({ old_public_key, new_public_key, timestamp, suite: SUITE }),
  );
  return {
    old_public_key,
    new_public_key,
    timestamp,
    suite: SUITE,
    old_key_signature: bytesToHex(await signBySuite(SUITE, msg, oldKp.privateKey)),
    new_key_signature: bytesToHex(await signBySuite(SUITE, msg, newKp.privateKey)),
  };
}

async function recoveryLinkAt(
  oldKp: KeyPair,
  newKp: KeyPair,
  guardianKp: KeyPair,
  timestamp: number,
): Promise<SuccessionRecord> {
  const old_public_key = bytesToHex(oldKp.publicKey);
  const new_public_key = bytesToHex(newKp.publicKey);
  const reason = "guardian_recovery";
  const msg = new TextEncoder().encode(
    canonicalJson({
      old_public_key,
      new_public_key,
      timestamp,
      suite: SUITE,
      reason,
      recovery: true,
    }),
  );
  return {
    old_public_key,
    new_public_key,
    timestamp,
    suite: SUITE,
    reason,
    recovery: true,
    new_key_signature: bytesToHex(await signBySuite(SUITE, msg, newKp.privateKey)),
    guardian_signature: bytesToHex(await signBySuite(SUITE, msg, guardianKp.privateKey)),
  };
}
