import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.env.HOME + "/.motebit-product-test/config.json", "utf8"));
const idmod = await import("/Users/daniel/src/motebit/apps/cli/src/identity.ts");
const privHex = await idmod.decryptPrivateKey(cfg.cli_encrypted_key, "product-test-2026");
const priv = idmod.fromHex(privHex);
const crypto = await import("@motebit/crypto");
const TASK = "22fc5f94-202a-4c31-98f5-9d4a03d3a449";
for (const aud of ["task:query", "task:submit"]) {
  const t = await crypto.mintAudienceToken({ mid: cfg.motebit_id, did: cfg.device_id, aud: aud as never }, priv);
  const r = await fetch(`https://relay.motebit.com/agent/${cfg.motebit_id}/task/${TASK}`, { headers: { authorization: "Bearer " + t.token } });
  const body = await r.text();
  console.log(aud, r.status, body.slice(0, 200));
  if (r.ok) {
    const d = JSON.parse(body);
    console.log("STATUS:", d.status, "has receipt:", d.receipt != null);
    if (d.receipt) { const fs = await import("node:fs"); fs.writeFileSync(process.env.HOME + "/.motebit-product-test/legC-receipt.json", JSON.stringify(d.receipt, null, 2)); console.log("receipt saved"); }
    break;
  }
}
