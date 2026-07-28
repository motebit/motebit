import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";

const HOME = process.env.HOME!;
const cfg = JSON.parse(readFileSync(HOME + "/.motebit-product-test/config.json", "utf8"));
const idmod = await import("/Users/daniel/src/motebit/apps/cli/src/identity.ts");
const privHex = await idmod.decryptPrivateKey(cfg.cli_encrypted_key, "product-test-2026");
const priv = idmod.fromHex(privHex);

const crypto = await import("@motebit/crypto");
const { resolveAndSubmitP2pDelegation } = await import("@motebit/runtime");
const { createSolanaWalletRail } = await import("@motebit/wallet-solana");

const RELAY_URL = "https://relay.motebit.com";

const RESEARCHER = "019d8167-406e-74c2-a517-81d3996aa160";

const rail = createSolanaWalletRail({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  identitySeed: Buffer.from(privHex, "hex"),
});

const authToken = async (aud?: string): Promise<string> => {
  const t = await crypto.mintAudienceToken(
    { mid: cfg.motebit_id, did: cfg.device_id, aud: (aud ?? "task:submit") as never },
    priv,
  );
  return t.token;
};

console.log("delegator:", cfg.motebit_id);
console.log("pinned relay key:", cfg.relay_public_key.slice(0, 16) + "…");

const result = await resolveAndSubmitP2pDelegation({
  motebitId: cfg.motebit_id,
  syncUrl: RELAY_URL,
  authToken,
  prompt: "What is SPIFFE/SPIRE and what problem does workload identity solve? Cite sources.",
  capability: "research",
  targetWorkerId: RESEARCHER,
  relayPublicKeyHex: cfg.relay_public_key,
  buildP2pPayment: (req: never) => rail.buildP2pPayment!(req),
  acknowledgeNoHistoryRisk: true,
  timeoutMs: 180000,
  logger: { warn: (m: string, ctx?: unknown) => console.warn("warn:", m, ctx ?? "") },
} as never);

if (!(result as { ok: boolean }).ok) {
  const e = (result as { error: { code: string; message: string } }).error;
  console.error("FAILED:", e.code, e.message);
  process.exit(1);
}
const receipt = (result as { receipt: Record<string, unknown> }).receipt;
writeFileSync(HOME + "/.motebit-product-test/legC-receipt.json", JSON.stringify(receipt, null, 2));
console.log("RECEIPT saved. task_id:", receipt["task_id"], "status fields:", Object.keys(receipt).slice(0, 12).join(","));

const { verifyReceiptVerdict } = await import("@motebit/verifier");
const verdict = await verifyReceiptVerdict(receipt as never);
console.log("receipt verdict:", JSON.stringify({ integrity: verdict.integrity, binding: verdict.identityBinding, sovereign: (verdict as never as Record<string, unknown>)["sovereign"] }));

const payload = JSON.parse(String(receipt["result"] ?? "{}"));
if (payload.attestation) {
  const att = payload.attestation;
  const vres = await (crypto as never as { verifyEvalAttestation: (a: unknown) => Promise<unknown> }).verifyEvalAttestation(att).catch((e: Error) => ({ err: e.message }));
  writeFileSync(HOME + "/.motebit-product-test/legB-attestation.json", JSON.stringify(att, null, 2));
  console.log("attestation subject:", att.subject ?? att.target ?? "?");
  console.log("attestation verify:", JSON.stringify(vres).slice(0, 300));
  console.log("checks:", JSON.stringify(payload.attestation.measurements ?? payload.attestation.checks ?? payload.summary ?? {}).slice(0, 500));
} else {
  console.log("result payload keys:", Object.keys(payload));
  console.log("raw result head:", String(receipt["result"]).slice(0, 400));
}
