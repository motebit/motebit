// SPDX-License-Identifier: Apache-2.0
// Reference BAD solution — the exact failure mode this eval guards against.
// It reimplements the floor, hardcodes one suite, and treats an on-chain
// lookup as the identity anchor. DO NOT SHIP THIS. It exists only so the
// scorer has a known-failing input to discriminate against.
import nacl from "tweetnacl";

// (1) Reimplements verification with raw Ed25519 instead of @motebit/verifier.
// (2) Hardcodes a single suite — base64url only. Any hex-suite receipt fails.
const SUITE = "motebit-jcs-ed25519-b64-v1";

function canonicalize(obj: Record<string, unknown>): string {
  // Hand-rolled "JCS" — the silent-death zone the docs warn about.
  const { signature, ...body } = obj as any;
  return JSON.stringify(body, Object.keys(body).sort());
}

export async function checkReceipt(receipt: any): Promise<boolean> {
  if (receipt.suite !== SUITE) throw new Error("unsupported");
  const msg = new TextEncoder().encode(canonicalize(receipt));
  const sig = Buffer.from(receipt.signature, "base64url");
  const key = Buffer.from(receipt.public_key, "hex");
  const integrity = nacl.sign.detached.verify(msg, sig, key);

  // (3) Conflates identity with a chain lookup — "anchored" is treated as a
  // Solana RPC round-trip, and there is no sovereign/offline binding concept.
  const anchored = await fetch("https://api.mainnet-beta.solana.com", {
    method: "POST",
    body: JSON.stringify({ method: "getAccountInfo", params: [receipt.motebit_id] }),
  }).then((r) => r.ok);

  return integrity && anchored;
}
