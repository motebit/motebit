/**
 * HttpJsonRpcEvmAdapter tests.
 *
 * Verifies the JSON-RPC envelope is constructed correctly, responses are
 * parsed into motebit-shaped {@link EvmTransferLog} values, and every failure
 * mode (network / non-2xx / JSON-RPC error / malformed body) surfaces as a
 * single `Error`.
 */
import { describe, it, expect, vi } from "vitest";
import { HttpJsonRpcEvmAdapter } from "../index.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function httpErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

describe("HttpJsonRpcEvmAdapter.getBlockNumber", () => {
  it("parses hex block number", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1a2b" }));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    const block = await adapter.getBlockNumber();

    expect(block).toBe(BigInt(0x1a2b));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toBe("https://rpc.example");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ jsonrpc: "2.0", method: "eth_blockNumber", params: [] });
  });

  it("throws on malformed result", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: 12345 }));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.getBlockNumber()).rejects.toThrow(/malformed/);
  });

  it("throws on JSON-RPC error response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "server boom" },
      }),
    );
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.getBlockNumber()).rejects.toThrow(/-32000.*server boom/);
  });

  it("throws on non-2xx HTTP", async () => {
    const fetchFn = vi.fn().mockResolvedValue(httpErrorResponse(503));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.getBlockNumber()).rejects.toThrow(/HTTP 503/);
  });

  it("wraps network errors with cause chain", async () => {
    const netErr = new Error("ECONNREFUSED");
    const fetchFn = vi.fn().mockRejectedValue(netErr);
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.getBlockNumber()).rejects.toMatchObject({
      message: expect.stringMatching(/network error/),
      cause: netErr,
    });
  });
});

describe("HttpJsonRpcEvmAdapter.getTransferLogs", () => {
  const contract = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  it("parses log array into motebit-shaped EvmTransferLog[]", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: [
          {
            transactionHash: "0xabc",
            logIndex: "0x5",
            topics: [
              TRANSFER_TOPIC,
              "0x000000000000000000000000" + "aa".repeat(20),
              "0x000000000000000000000000" + "bb".repeat(20),
            ],
            data: "0x" + BigInt(1_234_567).toString(16).padStart(64, "0"),
            blockNumber: "0x64",
          },
        ],
      }),
    );
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    const logs = await adapter.getTransferLogs({
      fromBlock: BigInt(100),
      toBlock: BigInt(110),
      contractAddress: contract,
      topic0: TRANSFER_TOPIC,
    });

    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.blockNumber).toBe(BigInt(100));
    expect(log.txHash).toBe("0xabc");
    expect(log.logIndex).toBe(5);
    expect(log.fromTopic.toLowerCase().endsWith("aa".repeat(20))).toBe(true);
    expect(log.toTopic.toLowerCase().endsWith("bb".repeat(20))).toBe(true);
    expect(BigInt(log.amountHex)).toBe(BigInt(1_234_567));

    // Envelope: method + hex-encoded block range + address + topics.
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.method).toBe("eth_getLogs");
    expect(body.params[0]).toMatchObject({
      address: contract,
      topics: [TRANSFER_TOPIC],
      fromBlock: "0x64",
      toBlock: "0x6e",
    });
  });

  it("includes to-address topic when caller narrows the filter", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: [] }));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await adapter.getTransferLogs({
      fromBlock: BigInt(0),
      toBlock: BigInt(1),
      contractAddress: contract,
      topic0: TRANSFER_TOPIC,
      toAddressTopic: "0x000000000000000000000000" + "cc".repeat(20),
    });

    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.params[0].topics).toEqual([
      TRANSFER_TOPIC,
      null,
      "0x000000000000000000000000" + "cc".repeat(20),
    ]);
  });

  it("skips logs that don't match topic0 or have too few topics", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: [
          // Non-Transfer event, different topic0.
          {
            transactionHash: "0x1",
            logIndex: "0x0",
            topics: ["0xdeadbeef"],
            data: "0x0",
            blockNumber: "0x1",
          },
          // Approval-shaped log (3 topics, wrong topic0).
          {
            transactionHash: "0x2",
            logIndex: "0x1",
            topics: ["0xbaadf00d", "0x" + "00".repeat(32), "0x" + "00".repeat(32)],
            data: "0x0",
            blockNumber: "0x1",
          },
        ],
      }),
    );
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    const logs = await adapter.getTransferLogs({
      fromBlock: BigInt(0),
      toBlock: BigInt(1),
      contractAddress: contract,
      topic0: TRANSFER_TOPIC,
    });
    expect(logs).toEqual([]);
  });

  it("throws when result is not an array", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: { not: "an array" } }));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(
      adapter.getTransferLogs({
        fromBlock: BigInt(0),
        toBlock: BigInt(1),
        contractAddress: contract,
        topic0: TRANSFER_TOPIC,
      }),
    ).rejects.toThrow(/non-array/);
  });

  it("throws on JSON-RPC error response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32005, message: "query returned more than 10000 results" },
      }),
    );
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(
      adapter.getTransferLogs({
        fromBlock: BigInt(0),
        toBlock: BigInt(1),
        contractAddress: contract,
        topic0: TRANSFER_TOPIC,
      }),
    ).rejects.toThrow(/10000 results/);
  });

  it("throws on malformed log entry", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: [{ transactionHash: "0x1" /* missing everything else */ }],
      }),
    );
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(
      adapter.getTransferLogs({
        fromBlock: BigInt(0),
        toBlock: BigInt(1),
        contractAddress: contract,
        topic0: TRANSFER_TOPIC,
      }),
    ).rejects.toThrow(/malformed/);
  });
});

describe("HttpJsonRpcEvmAdapter response envelope", () => {
  it("throws when response body is not JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("unexpected token");
      },
    } as unknown as Response);
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.getBlockNumber()).rejects.toThrow(/non-JSON/);
  });

  it("throws when response is missing the result field", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1 }));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.getBlockNumber()).rejects.toThrow(/missing result/);
  });

  it("uses globalThis.fetch when none is injected", () => {
    // Construction alone exercises the default-fetch branch without making a real network call.
    const adapter = new HttpJsonRpcEvmAdapter({ rpcUrl: "https://rpc.example" });
    expect(adapter).toBeInstanceOf(HttpJsonRpcEvmAdapter);
  });

  it("supports requestTimeoutMs via AbortController", async () => {
    // AbortController branch coverage — we never actually abort in this test; we
    // just prove the config path constructs a controller when the timeout is set.
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      requestTimeoutMs: 1000,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });
    await adapter.getBlockNumber();
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeDefined();
  });
});

describe("HttpJsonRpcEvmAdapter.getBalance", () => {
  // Canonical Base mainnet USDC contract.
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const TREASURY = "0xee51c5a65c6Fa81c9CC85505884290e90C09D285";

  it("encodes balanceOf(address) call data correctly", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: "0x00000000000000000000000000000000000000000000000000000000003d8528", // 4_026_152 micro-USDC
      }),
    );
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    const balance = await adapter.getBalance({
      contractAddress: USDC_BASE,
      accountAddress: TREASURY,
    });

    expect(balance).toBe(BigInt(0x3d8528));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as {
      method: string;
      params: [{ to: string; data: string }, string];
    };
    expect(body.method).toBe("eth_call");
    expect(body.params[0].to).toBe(USDC_BASE);
    expect(body.params[1]).toBe("latest");
    // Selector + 32-byte left-padded address (lowercased).
    const expectedData = "0x70a08231" + TREASURY.slice(2).toLowerCase().padStart(64, "0");
    expect(body.params[0].data).toBe(expectedData);
  });

  it("decodes hex uint256 to bigint", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        // 1_000_000 micro-USDC = $1.00
        result: "0x00000000000000000000000000000000000000000000000000000000000f4240",
      }),
    );
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    const balance = await adapter.getBalance({
      contractAddress: USDC_BASE,
      accountAddress: TREASURY,
    });

    expect(balance).toBe(1_000_000n);
  });

  it("treats `0x` (empty return data, e.g. revert) as 0", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x" }));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    const balance = await adapter.getBalance({
      contractAddress: USDC_BASE,
      accountAddress: TREASURY,
    });

    expect(balance).toBe(0n);
  });

  it("rejects malformed account address", async () => {
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });

    await expect(
      adapter.getBalance({
        contractAddress: USDC_BASE,
        accountAddress: "not-an-address",
      }),
    ).rejects.toThrow(/malformed accountAddress/);
  });

  it("collapses RPC error to a single Error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "execution reverted" },
      }),
    );
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(
      adapter.getBalance({ contractAddress: USDC_BASE, accountAddress: TREASURY }),
    ).rejects.toThrow(/RPC eth_call error -32000/);
  });

  it("collapses non-2xx HTTP to a single Error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(httpErrorResponse(503));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(
      adapter.getBalance({ contractAddress: USDC_BASE, accountAddress: TREASURY }),
    ).rejects.toThrow(/RPC eth_call returned HTTP 503/);
  });

  it("rejects malformed (non-hex) result", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: 12345 }));
    const adapter = new HttpJsonRpcEvmAdapter({
      rpcUrl: "https://rpc.example",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(
      adapter.getBalance({ contractAddress: USDC_BASE, accountAddress: TREASURY }),
    ).rejects.toThrow(/malformed result/);
  });
});
