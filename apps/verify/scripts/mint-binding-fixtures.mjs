/**
 * Mint the served-chain binding fixtures for page.test.ts (round 2 of the
 * receipt.computer overclaim mitigation): G1–G3 (a relay-served chain that binds
 * the key at the receipt's time), FG / FGL (a "recovery" link signed by a
 * guardian named only inside the served file), FS (a served chain whose genesis
 * is not the key a self-certifying id commits to). Public demo seeds only.
 * Rotation timestamps are Date.now(), so re-minting changes the bytes, not the
 * verdicts. Needs packages/crypto built.
 *
 *   node apps/verify/scripts/mint-binding-fixtures.mjs
 */
import { writeFileSync } from "node:fs";
const C = new URL("../../../", import.meta.url).pathname;
const c = await import(`${C}/packages/crypto/dist/index.js`);
const OUT = `${C}/apps/verify/src/__tests__/fixtures/`;
const utf8 = (s) => new TextEncoder().encode(s);
const seed = (start) => {
  const s = new Uint8Array(32);
  for (let i = 0; i < 32; i++) s[i] = (start + i) & 0xff;
  return s;
};
const B64 = "motebit-jcs-ed25519-b64-v1";
async function kp(start) {
  const priv = seed(start);
  const pub = await c.getPublicKeyBySuite(priv, B64);
  return { priv, pub, hex: c.bytesToHex(pub) };
}
const victim = await kp(0x01),
  attacker = await kp(0xa1),
  k1 = await kp(0xb1),
  guardian = await kp(0xc1),
  legacy = await kp(0xd1),
  forger = await kp(0xf1);
const victimId = await c.deriveSovereignMotebitId(victim.hex);
const LEGACY_ID = "019dc500-0000-7abc-8000-00000000beef";
async function body(over = {}) {
  const result = over.result ?? "Paid invoice #42 for $5.00.";
  return {
    task_id: over.task_id ?? "rc-task-1",
    motebit_id: over.motebit_id ?? victimId,
    device_id: "rc-device",
    submitted_at: over.submitted_at ?? 1790000000000,
    completed_at: over.completed_at ?? 1790000001000,
    status: "completed",
    result,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: await c.hash(utf8("prompt")),
    result_hash: await c.hash(utf8(result)),
  };
}
const signLib = async (b, k) => c.signExecutionReceipt(b, k.priv, k.pub);
const W = (name, obj, ctx) => {
  writeFileSync(OUT + name + ".json", JSON.stringify(obj, null, 2) + "\n");
  if (ctx) writeFileSync(OUT + name + ".ctx.json", JSON.stringify(ctx, null, 2) + "\n");
};
const bundle = (id, cur, succession = [], extra = {}) => ({
  motebit_id: id,
  created_at: new Date(1780000000000).toISOString(),
  current_public_key: cur,
  succession,
  anchored: null,
  ...extra,
});
const good = await signLib(await body(), victim);
const rot = await c.signKeySuccession(victim.priv, k1.priv, k1.pub, victim.pub, "rotation");
const T1 = rot.timestamp;
const after = { completed_at: T1 + 60000, submitted_at: T1 + 59000 };
W("G1-genesis-current-chain-served", good, { bundle: bundle(victimId, victim.hex), memos: [] });
W("G2-historical-before-rotation-chain-served", good, {
  bundle: bundle(victimId, k1.hex, [rot]),
  memos: [],
});
W("G3-rotated-key-chain-served", await signLib(await body({ task_id: "rc-k1", ...after }), k1), {
  bundle: bundle(victimId, k1.hex, [rot]),
  memos: [],
});
// Forged guardian: the relay-served file names a guardian the motebit never had; a
// "recovery" link signed by it hands the sovereign id to the attacker's key.
const forged = await c.signGuardianRecoverySuccession(
  forger.priv,
  attacker.priv,
  victim.pub,
  attacker.pub,
);
W(
  "FG-forged-guardian-recovery",
  await signLib(await body({ task_id: "rc-forged", ...after }), attacker),
  {
    bundle: bundle(victimId, attacker.hex, [forged], { guardian_public_key: forger.hex }),
    memos: [],
  },
);
// Same forgery on a legacy (non-committing) id: the served chain's genesis is the legacy key.
const forgedL = await c.signGuardianRecoverySuccession(
  forger.priv,
  attacker.priv,
  legacy.pub,
  attacker.pub,
);
W(
  "FGL-forged-guardian-recovery-legacy",
  await signLib(
    await body({ motebit_id: LEGACY_ID, task_id: "rc-forged-legacy", ...after }),
    attacker,
  ),
  {
    bundle: bundle(LEGACY_ID, attacker.hex, [forgedL], { guardian_public_key: forger.hex }),
    memos: [],
  },
);
console.log("T1", T1, "victimId", victimId);
// A served chain whose genesis is NOT the key the self-certifying id commits to.
W(
  "FS-served-genesis-not-id-commitment",
  await signLib(await body({ task_id: "rc-foreign-genesis" }), attacker),
  { bundle: bundle(victimId, attacker.hex), memos: [] },
);
