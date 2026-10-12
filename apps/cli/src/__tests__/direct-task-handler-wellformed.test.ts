/**
 * The direct handler signs a receipt over well-formed text, whatever the tool
 * returned. `signExecutionReceipt` refuses a lone surrogate
 * (UnpairedSurrogateError, spec/execution-ledger-v1.md §11.4); main's inline
 * handler normalized with `toWellFormedText` (#1097) and the gated handler must
 * too — otherwise the sign call throws out of the task generator and the task
 * has no receipt at all.
 */
import { describe, it, expect } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import { RiskLevel } from "@motebit/sdk";
import type { ToolDefinition } from "@motebit/sdk";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { createDirectTaskHandler } from "../direct-task-handler.js";

const ECHO: ToolDefinition = {
  name: "echo",
  mode: "api",
  description: "Echo the input",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  riskHint: { risk: RiskLevel.R0_READ },
};

async function run(data: unknown): Promise<Record<string, unknown> | undefined> {
  const worker = await generateKeypair();
  const runtime = new MotebitRuntime(
    { motebitId: "worker-wf", tickRateHz: 0, signingKeys: worker },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
  runtime.getToolRegistry().register(ECHO, async () => ({ ok: true, data }));
  const handler = createDirectTaskHandler({
    runtime,
    motebitId: "worker-wf",
    deviceId: "dev-wf",
    publicKeyHex: bytesToHex(worker.publicKey),
    privateKey: worker.privateKey,
    preferExternalTools: false,
    log: () => {},
  });
  let receipt: Record<string, unknown> | undefined;
  for await (const chunk of handler("hello", { relayTaskId: "relay-task-wf" })) {
    if (chunk.type === "task_result") receipt = chunk.receipt;
  }
  return receipt;
}

describe("direct task handler — well-formed text before signing", () => {
  it("a tool result ending in a lone surrogate still yields a signed receipt", async () => {
    const receipt = await run("partial \uD83D");
    expect(receipt?.["status"]).toBe("completed");
    expect(typeof receipt?.["signature"]).toBe("string");
    expect(receipt?.["result"]).toBe("partial \uFFFD");
  });
});
