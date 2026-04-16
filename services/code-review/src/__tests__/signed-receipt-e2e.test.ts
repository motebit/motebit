/**
 * Signed-receipt E2E — molecule agent (code-review → read-url).
 *
 * Real Ed25519 keypairs for both the read-url atom and the code-review caller.
 * Real McpClientAdapter driving the real in-process read-url MCP server. The
 * Anthropic SDK is mocked at module load (it is NOT on the signing path —
 * only the LLM's review text is mocked; every delegation receipt comes from
 * buildServiceReceipt with a real private key).
 *
 * Assertion surface:
 *   1. The review result carries exactly one delegation receipt (the read-url
 *      receipt from the .patch fetch).
 *   2. That receipt verifies offline against the atom's public key.
 *   3. Wrapping the review result in an outer code-review receipt via
 *      buildServiceReceipt and embedding delegation_receipts produces a tree
 *      that passes verifyReceiptChain against the { code-review, read-url }
 *      key map.
 *   4. Cryptosuite pin: both receipts carry "motebit-jcs-ed25519-b64-v1".
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Anthropic is mocked — not on the signing path.
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// eslint-disable-next-line no-restricted-imports -- E2E tests need direct crypto
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  verifyExecutionReceipt,
  verifyReceiptChain,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { buildServiceReceipt } from "@motebit/mcp-server";
import { AgentTrustLevel } from "@motebit/sdk";
import type { ExecutionReceipt } from "@motebit/sdk";

import { reviewPrViaMotebit } from "../review-via-motebit.js";
import { startReadUrlAtom } from "./fixtures/atom-service.js";
import type { AtomFixture } from "./fixtures/atom-service.js";

const READ_URL_MOTEBIT_ID = "01961234-cr01-7abc-def0-000000000001";
const READ_URL_DEVICE_ID = "read-url-cr-device";
const READ_URL_PORT = 39401;

const CR_MOTEBIT_ID = "01961234-cr02-7abc-def0-000000000002";
const CR_DEVICE_ID = "code-review-service";

const SAMPLE_PATCH = [
  "From abc123def456",
  "From: Alice Example <alice@example.com>",
  "Date: Mon, 14 Apr 2026 10:00:00 +0000",
  "Subject: [PATCH] Add sovereign settlement",
  "",
  "diff --git a/foo.ts b/foo.ts",
  "@@ -1,3 +1,4 @@",
  " existing line",
  "+new line",
  " existing line",
].join("\n");

let atom: AtomFixture;
let reviewerKeypair: KeyPair;

beforeAll(async () => {
  // The reviewer keypair must be generated BEFORE the atom boots, so we can
  // register it in knownCallers. McpClientAdapter uses motebit-signed tokens
  // when `motebit: true`, which the atom verifies against this map.
  reviewerKeypair = await generateKeypair();
  const reviewerPublicKeyHex = bytesToHex(reviewerKeypair.publicKey);

  atom = await startReadUrlAtom({
    motebitId: READ_URL_MOTEBIT_ID,
    deviceId: READ_URL_DEVICE_ID,
    port: READ_URL_PORT,
    readUrlResponse: () => ({ ok: true, data: SAMPLE_PATCH }),
    knownCallers: new Map([
      [CR_MOTEBIT_ID, { publicKey: reviewerPublicKeyHex, trustLevel: AgentTrustLevel.Verified }],
    ]),
  });
}, 30_000);

afterAll(async () => {
  await atom.stop();
});

describe("code-review — signed receipt E2E (molecule → read-url)", () => {
  it("reviewPrViaMotebit captures exactly one signed delegation receipt", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "## Verdict: APPROVE — clean diff." }],
    });

    const result = await reviewPrViaMotebit("https://github.com/foo/bar/pull/1", {
      anthropicApiKey: "sk-ant-test",
      readUrlUrl: atom.url,
      callerMotebitId: CR_MOTEBIT_ID,
      callerDeviceId: CR_DEVICE_ID,
      callerPrivateKey: reviewerKeypair.privateKey,
    });

    expect(result.review).toContain("APPROVE");
    expect(result.pr.title).toBe("Add sovereign settlement");
    expect(result.pr.author).toBe("Alice Example");

    // The cryptographic edge: exactly one receipt (the .patch fetch).
    expect(result.delegation_receipts).toHaveLength(1);

    const receipt = result.delegation_receipts[0]!;
    expect(receipt.motebit_id).toBe(READ_URL_MOTEBIT_ID);
    expect(receipt.tools_used).toEqual(["read_url"]);
    expect(receipt.status).toBe("completed");
    expect(receipt.signature.length).toBeGreaterThan(0);
  });

  it("the captured receipt verifies offline against the atom's public key", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });
    const result = await reviewPrViaMotebit("https://github.com/foo/bar/pull/2", {
      anthropicApiKey: "sk-ant-test",
      readUrlUrl: atom.url,
      callerMotebitId: CR_MOTEBIT_ID,
      callerDeviceId: CR_DEVICE_ID,
      callerPrivateKey: reviewerKeypair.privateKey,
    });

    const receipt = result.delegation_receipts[0]!;
    const valid = await verifyExecutionReceipt(receipt, hexToBytes(atom.publicKeyHex));
    expect(valid).toBe(true);
  });

  it("cryptosuite is pinned to motebit-jcs-ed25519-b64-v1 on the delegation receipt", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });
    const result = await reviewPrViaMotebit("https://github.com/foo/bar/pull/3", {
      anthropicApiKey: "sk-ant-test",
      readUrlUrl: atom.url,
      callerMotebitId: CR_MOTEBIT_ID,
      callerDeviceId: CR_DEVICE_ID,
      callerPrivateKey: reviewerKeypair.privateKey,
    });
    expect(result.delegation_receipts[0]!.suite).toBe("motebit-jcs-ed25519-b64-v1");
  });

  it("full receipt chain verifies with verifyReceiptChain when the caller wraps its own receipt", async () => {
    // Simulates what index.ts does: after reviewPrViaMotebit returns, it calls
    // buildServiceReceipt with delegationReceipts=result.delegation_receipts.
    // Exercising that chain end-to-end proves the spec §11.5 recursive verify
    // path works for the code-review molecule.
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "## Verdict: APPROVE" }],
    });
    const submittedAt = Date.now();
    const result = await reviewPrViaMotebit("https://github.com/foo/bar/pull/4", {
      anthropicApiKey: "sk-ant-test",
      readUrlUrl: atom.url,
      callerMotebitId: CR_MOTEBIT_ID,
      callerDeviceId: CR_DEVICE_ID,
      callerPrivateKey: reviewerKeypair.privateKey,
    });

    const outer = await buildServiceReceipt({
      motebitId: CR_MOTEBIT_ID,
      deviceId: CR_DEVICE_ID,
      privateKey: reviewerKeypair.privateKey,
      publicKey: reviewerKeypair.publicKey,
      prompt: "https://github.com/foo/bar/pull/4",
      taskId: crypto.randomUUID(),
      submittedAt,
      result: result.review,
      ok: true,
      toolsUsed: ["code_review"],
      delegationReceipts: result.delegation_receipts,
    });

    expect(outer.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(outer.delegation_receipts).toHaveLength(1);
    expect(outer.delegation_receipts![0]!.motebit_id).toBe(READ_URL_MOTEBIT_ID);

    const knownKeys = new Map<string, Uint8Array>([
      [CR_MOTEBIT_ID, reviewerKeypair.publicKey],
      [READ_URL_MOTEBIT_ID, hexToBytes(atom.publicKeyHex)],
    ]);
    const chainResult = await verifyReceiptChain(outer, knownKeys);
    expect(chainResult.verified).toBe(true);
    expect(chainResult.delegations).toHaveLength(1);
    expect(chainResult.delegations[0]!.verified).toBe(true);
  });

  it("tampering with the atom's receipt result breaks chain verification", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });
    const result = await reviewPrViaMotebit("https://github.com/foo/bar/pull/5", {
      anthropicApiKey: "sk-ant-test",
      readUrlUrl: atom.url,
      callerMotebitId: CR_MOTEBIT_ID,
      callerDeviceId: CR_DEVICE_ID,
      callerPrivateKey: reviewerKeypair.privateKey,
    });

    const tamperedInner = {
      ...result.delegation_receipts[0]!,
      result: "FABRICATED PATCH",
    } as ExecutionReceipt;

    const outer = await buildServiceReceipt({
      motebitId: CR_MOTEBIT_ID,
      deviceId: CR_DEVICE_ID,
      privateKey: reviewerKeypair.privateKey,
      publicKey: reviewerKeypair.publicKey,
      prompt: "https://github.com/foo/bar/pull/5",
      taskId: crypto.randomUUID(),
      submittedAt: Date.now(),
      result: result.review,
      ok: true,
      toolsUsed: ["code_review"],
      delegationReceipts: [tamperedInner],
    });

    const knownKeys = new Map<string, Uint8Array>([
      [CR_MOTEBIT_ID, reviewerKeypair.publicKey],
      [READ_URL_MOTEBIT_ID, hexToBytes(atom.publicKeyHex)],
    ]);
    const chainResult = await verifyReceiptChain(outer, knownKeys);
    // The outer receipt still verifies (we re-signed after mutating its inner
    // link); verifyReceiptChain reports per-level state in `delegations`. A
    // chain is only trustworthy when every level verifies — callers MUST
    // walk `delegations` and enforce that invariant.
    expect(chainResult.verified).toBe(true);
    expect(chainResult.delegations[0]!.verified).toBe(false);
    // Guard the invariant callers must enforce.
    const allValid = chainResult.verified && chainResult.delegations.every((d) => d.verified);
    expect(allValid).toBe(false);
  });

  // Silence unused-variable warning for the imported bytesToHex helper in case
  // future chain tests want to log hex keys.
  it("atom public key is deterministically hex-encodable", () => {
    expect(bytesToHex(atom.keypair.publicKey)).toBe(atom.publicKeyHex);
  });
});
