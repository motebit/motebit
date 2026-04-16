/**
 * Test fixture: spin up a real read-url atom MCP server with a real keypair
 * and a static in-memory read-url handler so we exercise the full signed-
 * receipt path without touching the network.
 *
 * Kept local to services/read-url; signed-receipt-e2e tests in other services
 * (services/api, services/code-review, services/research) each spin up their
 * own atom with the shape they need. embed and proxy are skipped — they are
 * utility services that do not sign receipts.
 */

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import { InMemoryToolRegistry } from "@motebit/tools";
import { readUrlDefinition } from "@motebit/tools";
import { McpServerAdapter, buildServiceReceipt } from "@motebit/mcp-server";
import type { MotebitServerDeps } from "@motebit/mcp-server";
import { generateKeypair, bytesToHex, verifySignedToken } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { generate as generateIdentity } from "@motebit/identity-file";
import type { ToolResult } from "@motebit/sdk";

export interface AtomFixture {
  server: McpServerAdapter;
  runtime: MotebitRuntime;
  keypair: KeyPair;
  motebitId: string;
  deviceId: string;
  publicKeyHex: string;
  port: number;
  authToken: string;
  url: string;
  stop(): Promise<void>;
}

export interface AtomFixtureOptions {
  motebitId: string;
  deviceId: string;
  port: number;
  authToken?: string;
  /** Static content returned by read_url handler. */
  readUrlResponse?: (url: string) => ToolResult;
}

const DEFAULT_TOKEN = "test-atom-token";

/**
 * Build and start a read-url atom MCP server with a fresh Ed25519 keypair.
 * handleAgentTask routes through `buildServiceReceipt` — the shared primitive
 * in @motebit/mcp-server — so this exercises the exact signing path production
 * services use.
 */
export async function startReadUrlAtom(opts: AtomFixtureOptions): Promise<AtomFixture> {
  const keypair = await generateKeypair();
  const publicKeyHex = bytesToHex(keypair.publicKey);
  const authToken = opts.authToken ?? DEFAULT_TOKEN;

  const identityContent = await generateIdentity(
    {
      motebitId: opts.motebitId,
      ownerId: "test-owner",
      publicKeyHex,
      service: {
        type: "service",
        service_name: "read-url-test",
        service_description: "read-url atom fixture",
        capabilities: ["read_url"],
      },
    },
    keypair.privateKey,
  );

  const registry = new InMemoryToolRegistry();
  const handler = opts.readUrlResponse
    ? async (args: Record<string, unknown>) => opts.readUrlResponse!(args["url"] as string)
    : async (args: Record<string, unknown>) => {
        const url = typeof args["url"] === "string" ? args["url"] : "";
        return { ok: true as const, data: `static-read-url-content-for:${url}` };
      };
  registry.register(readUrlDefinition, handler);

  const runtime = new MotebitRuntime(
    { motebitId: opts.motebitId },
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), tools: registry },
  );
  await runtime.init();

  const deps: MotebitServerDeps = {
    motebitId: opts.motebitId,
    publicKeyHex,
    listTools: () => runtime.getToolRegistry().list(),
    filterTools: (tools) => runtime.policy.filterTools(tools),
    validateTool: () => ({ allowed: true, requiresApproval: false }),
    executeTool: (name, args) => runtime.getToolRegistry().execute(name, args),
    getState: () => runtime.getState() as unknown as Record<string, unknown>,
    getMemories: async () => [],
    logToolCall: () => {},
    verifySignedToken: async (token, pk) => verifySignedToken(token, pk),
    identityFileContent: identityContent,
    handleAgentTask: async function* (
      prompt: string,
      options?: { relayTaskId?: string; delegatedScope?: string },
    ) {
      const taskId = crypto.randomUUID();
      const submittedAt = Date.now();
      let result: ToolResult;
      try {
        result = await runtime.getToolRegistry().execute("read_url", { url: prompt });
      } catch (err: unknown) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const resultStr = result.ok
        ? typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data ?? null)
        : (result.error ?? "error");
      const signed = await buildServiceReceipt({
        motebitId: opts.motebitId,
        deviceId: opts.deviceId,
        privateKey: keypair.privateKey,
        publicKey: keypair.publicKey,
        prompt,
        taskId,
        submittedAt,
        result: resultStr,
        ok: result.ok,
        toolsUsed: ["read_url"],
        relayTaskId: options?.relayTaskId,
        delegatedScope: options?.delegatedScope,
      });
      yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
    },
  };

  const server = new McpServerAdapter(
    {
      name: `read-url-atom-${opts.motebitId.slice(0, 8)}`,
      transport: "http",
      port: opts.port,
      motebitType: "service",
      authToken,
    },
    deps,
  );
  await server.start();

  return {
    server,
    runtime,
    keypair,
    motebitId: opts.motebitId,
    deviceId: opts.deviceId,
    publicKeyHex,
    port: opts.port,
    authToken,
    url: `http://localhost:${opts.port}/mcp`,
    async stop(): Promise<void> {
      try {
        await server.stop();
      } catch {
        /* ignore */
      }
      try {
        runtime.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Strip the identity tag appended by formatResult. */
export function stripIdentityTag(text: string): string {
  return text.replace(/\n\[motebit:[^\]]+\]$/, "");
}
