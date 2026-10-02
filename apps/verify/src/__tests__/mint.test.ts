import { describe, it, expect } from "vitest";
import { getPublicKeyBySuite } from "@motebit/crypto";
import { verifyReceiptDocument } from "@motebit/state-export-client";
import { mintDemoReceipt } from "../mint.js";
import { tamperResult } from "../sample.js";

describe("mint → verify", () => {
  it("a receipt minted with a fresh browser key verifies — and verifies sovereign", async () => {
    const json = await mintDemoReceipt({ prompt: "What is 2 + 2?", result: "4" });
    const v = await verifyReceiptDocument(json);
    expect(v.integrity).toBe(true);
    // The lesson the page teaches: a key minted a second ago is "sovereign".
    expect(v.binding).toBe("sovereign");
    const r = JSON.parse(json) as Record<string, unknown>;
    expect(r["result"]).toBe("4");
    expect(r["suite"]).toBe("motebit-jcs-ed25519-b64-v1");
    expect(typeof r["public_key"]).toBe("string");
    expect(r).not.toHaveProperty("private_key");
  });

  it("is deterministic given the key, clock and task id; tampering breaks it", async () => {
    const privateKey = new Uint8Array(32).fill(7);
    const keypair = {
      privateKey,
      publicKey: await getPublicKeyBySuite(privateKey, "motebit-jcs-ed25519-b64-v1"),
    };
    const opts = { keypair, now: 1790000000000, taskId: "t-fixed" };
    const a = await mintDemoReceipt({ prompt: "p", result: "Result" }, opts);
    const b = await mintDemoReceipt({ prompt: "p", result: "Result" }, opts);
    expect(a).toBe(b);
    expect(json(a)["submitted_at"]).toBe(1790000000000);
    const t = tamperResult(a)!;
    expect((await verifyReceiptDocument(t)).integrity).toBe(false);
  });

  it("each mint uses a different throwaway key", async () => {
    const a = json(await mintDemoReceipt({ prompt: "p", result: "r" }));
    const b = json(await mintDemoReceipt({ prompt: "p", result: "r" }));
    expect(a["public_key"]).not.toBe(b["public_key"]);
  });
});

function json(s: string): Record<string, unknown> {
  return JSON.parse(s) as Record<string, unknown>;
}
