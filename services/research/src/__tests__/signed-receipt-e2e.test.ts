/**
 * Signed-receipt E2E — research molecule (citations as receipt chain).
 *
 * Two real atom MCP servers (web-search + read-url) backed by real Ed25519
 * keypairs. The Anthropic SDK is mocked at module load — the LLM is not on
 * the signing path, only its tool-use sequence is scripted.
 *
 * This is the citation-as-receipt-chain doctrine: citations MUST be signed
 * delegation-receipt chains, not text strings. The research molecule drives
 * a real McpClientAdapter into each atom and accumulates the receipts it
 * returns. Offline verify against the { research, web-search, read-url }
 * keymap proves the whole chain.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Anthropic is mocked — not on the signing path. Each test scripts the
// tool_use → text sequence.
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

import { research } from "../research.js";
import { startAtom } from "./fixtures/atom-service.js";
import type { AtomFixture } from "./fixtures/atom-service.js";

const WS_MOTEBIT_ID = "01961234-rs01-7abc-def0-000000000001";
const WS_DEVICE_ID = "web-search-rs-device";
// Below Linux's default ephemeral range (32768–60999) so parallel turbo runs of
// `port: 0` MCP-server tests cannot grab these ports out from under us.
const WS_PORT = 19501;

const RU_MOTEBIT_ID = "01961234-rs02-7abc-def0-000000000002";
const RU_DEVICE_ID = "read-url-rs-device";
const RU_PORT = 19502;

const RESEARCH_MOTEBIT_ID = "01961234-rs03-7abc-def0-000000000003";
const RESEARCH_DEVICE_ID = "research-service";

const STATIC_RESULTS = JSON.stringify([
  { title: "Doc A", url: "https://example.com/a", snippet: "about a" },
  { title: "Doc B", url: "https://example.com/b", snippet: "about b" },
]);

let wsAtom: AtomFixture;
let ruAtom: AtomFixture;
let researcherKeypair: KeyPair;

beforeAll(async () => {
  researcherKeypair = await generateKeypair();
  const researcherPublicKeyHex = bytesToHex(researcherKeypair.publicKey);
  const knownCallers = new Map([
    [
      RESEARCH_MOTEBIT_ID,
      { publicKey: researcherPublicKeyHex, trustLevel: AgentTrustLevel.Verified },
    ],
  ]);

  wsAtom = await startAtom({
    kind: "web-search",
    motebitId: WS_MOTEBIT_ID,
    deviceId: WS_DEVICE_ID,
    port: WS_PORT,
    handler: () => ({ ok: true, data: STATIC_RESULTS }),
    knownCallers,
  });

  ruAtom = await startAtom({
    kind: "read-url",
    motebitId: RU_MOTEBIT_ID,
    deviceId: RU_DEVICE_ID,
    port: RU_PORT,
    handler: (args) => {
      const url = typeof args["url"] === "string" ? args["url"] : "?";
      return { ok: true, data: `page-content:${url}` };
    },
    knownCallers,
  });
}, 30_000);

afterAll(async () => {
  await Promise.all([wsAtom.stop(), ruAtom.stop()]);
});

describe("research — signed receipt E2E (molecule → web-search + read-url)", () => {
  it("accumulates exactly one receipt per delegated atom call, ordered by dispatch", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "motebit_web_search",
            input: { query: "what is x" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "motebit_read_url",
            input: { url: "https://example.com/a" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "## Findings\nSynthesized report with citations [1]." }],
      });

    const result = await research("what is x", {
      anthropicApiKey: "sk-ant-test",
      webSearchUrl: wsAtom.url,
      readUrlUrl: ruAtom.url,
      callerMotebitId: RESEARCH_MOTEBIT_ID,
      callerDeviceId: RESEARCH_DEVICE_ID,
      callerPrivateKey: researcherKeypair.privateKey,
      maxToolCalls: 8,
    });

    expect(result.search_count).toBe(1);
    expect(result.fetch_count).toBe(1);
    expect(result.delegation_receipts).toHaveLength(2);

    // Order: search first, then fetch.
    expect(result.delegation_receipts[0]!.motebit_id).toBe(WS_MOTEBIT_ID);
    expect(result.delegation_receipts[0]!.tools_used).toEqual(["web_search"]);
    expect(result.delegation_receipts[1]!.motebit_id).toBe(RU_MOTEBIT_ID);
    expect(result.delegation_receipts[1]!.tools_used).toEqual(["read_url"]);
  });

  it("every atom receipt verifies offline against its atom's public key", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "motebit_web_search",
            input: { query: "verify me" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "motebit_read_url",
            input: { url: "https://example.com/b" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Done." }],
      });

    const result = await research("verify me", {
      anthropicApiKey: "sk-ant-test",
      webSearchUrl: wsAtom.url,
      readUrlUrl: ruAtom.url,
      callerMotebitId: RESEARCH_MOTEBIT_ID,
      callerDeviceId: RESEARCH_DEVICE_ID,
      callerPrivateKey: researcherKeypair.privateKey,
      maxToolCalls: 8,
    });

    const searchOk = await verifyExecutionReceipt(
      result.delegation_receipts[0] as ExecutionReceipt,
      hexToBytes(wsAtom.publicKeyHex),
    );
    const fetchOk = await verifyExecutionReceipt(
      result.delegation_receipts[1] as ExecutionReceipt,
      hexToBytes(ruAtom.publicKeyHex),
    );
    expect(searchOk).toBe(true);
    expect(fetchOk).toBe(true);
  });

  it("cryptosuite motebit-jcs-ed25519-b64-v1 is pinned on every receipt in the chain", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "pin" } },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "." }],
      });

    const result = await research("pin", {
      anthropicApiKey: "sk-ant-test",
      webSearchUrl: wsAtom.url,
      readUrlUrl: ruAtom.url,
      callerMotebitId: RESEARCH_MOTEBIT_ID,
      callerDeviceId: RESEARCH_DEVICE_ID,
      callerPrivateKey: researcherKeypair.privateKey,
      maxToolCalls: 8,
    });

    for (const r of result.delegation_receipts) {
      expect((r as ExecutionReceipt).suite).toBe("motebit-jcs-ed25519-b64-v1");
    }
  });

  it("full tree verifies with verifyReceiptChain when the caller wraps its own receipt (citation-as-chain doctrine)", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "tree" } },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "motebit_read_url",
            input: { url: "https://example.com/a" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "## Report" }],
      });

    const result = await research("tree", {
      anthropicApiKey: "sk-ant-test",
      webSearchUrl: wsAtom.url,
      readUrlUrl: ruAtom.url,
      callerMotebitId: RESEARCH_MOTEBIT_ID,
      callerDeviceId: RESEARCH_DEVICE_ID,
      callerPrivateKey: researcherKeypair.privateKey,
      maxToolCalls: 8,
    });

    // Build the outer research receipt the way index.ts does in production.
    const outer = await buildServiceReceipt({
      motebitId: RESEARCH_MOTEBIT_ID,
      deviceId: RESEARCH_DEVICE_ID,
      privateKey: researcherKeypair.privateKey,
      publicKey: researcherKeypair.publicKey,
      prompt: "tree",
      taskId: crypto.randomUUID(),
      submittedAt: Date.now(),
      result: result.report,
      ok: true,
      toolsUsed: ["research"],
      delegationReceipts: result.delegation_receipts as ExecutionReceipt[],
    });

    expect(outer.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(outer.delegation_receipts).toHaveLength(2);

    const knownKeys = new Map<string, Uint8Array>([
      [RESEARCH_MOTEBIT_ID, researcherKeypair.publicKey],
      [WS_MOTEBIT_ID, hexToBytes(wsAtom.publicKeyHex)],
      [RU_MOTEBIT_ID, hexToBytes(ruAtom.publicKeyHex)],
    ]);
    const chainResult = await verifyReceiptChain(outer, knownKeys);
    expect(chainResult.verified).toBe(true);
    expect(chainResult.delegations).toHaveLength(2);
    expect(chainResult.delegations.every((d) => d.verified)).toBe(true);
  });

  it("atom receipts resolve to the correct atom motebit_ids (not just 'some receipt')", async () => {
    // The doctrine says "citation IS the receipt" — callers must be able to
    // recover *which* agent produced each citation, not just "something did".
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "id-test" } },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "motebit_read_url",
            input: { url: "https://example.com/a" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "." }],
      });

    const result = await research("id-test", {
      anthropicApiKey: "sk-ant-test",
      webSearchUrl: wsAtom.url,
      readUrlUrl: ruAtom.url,
      callerMotebitId: RESEARCH_MOTEBIT_ID,
      callerDeviceId: RESEARCH_DEVICE_ID,
      callerPrivateKey: researcherKeypair.privateKey,
      maxToolCalls: 8,
    });

    const ids = result.delegation_receipts.map((r) => (r as ExecutionReceipt).motebit_id);
    expect(ids).toContain(WS_MOTEBIT_ID);
    expect(ids).toContain(RU_MOTEBIT_ID);
  });
});
