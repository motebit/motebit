/**
 * Motebit Read-URL Service (Charlie)
 *
 * A minimal tool server exposing only read_url via MCP.
 * Used as the second hop in multi-hop delegation: Alice → Bob → Charlie.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import type { StorageAdapters } from "@motebit/runtime";
import { openMotebitDatabase } from "@motebit/persistence";
import { InMemoryToolRegistry, readUrlDefinition, createReadUrlHandler } from "@motebit/tools";
import { wireServerDeps, startServiceServer } from "@motebit/mcp-server";
import {
  verifyIdentityFile,
  governanceToPolicyConfig,
  parseRiskLevel,
} from "@motebit/identity-file";
import { verifySignedToken, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import { embedText } from "@motebit/memory-graph";

function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3200", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/read-url.db",
    identityPath: process.env["MOTEBIT_IDENTITY_PATH"] ?? "./motebit.md",
    privateKeyHex: process.env["MOTEBIT_PRIVATE_KEY_HEX"],
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    apiToken: process.env["MOTEBIT_API_TOKEN"],
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"],
  };
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function main(): Promise<void> {
  const config = loadConfig();

  // 1. Load and verify identity
  const identityPath = path.resolve(config.identityPath);
  if (!fs.existsSync(identityPath)) {
    console.error(
      `No identity file found at ${identityPath}. Generate one: npx create-motebit . --service`,
    );
    process.exit(1);
  }
  const identityContent = fs.readFileSync(identityPath, "utf-8");
  const verifyResult = await verifyIdentityFile(identityContent);
  if (!verifyResult.valid || !verifyResult.identity) {
    console.error(`Identity verification failed: ${verifyResult.error ?? "unknown error"}`);
    process.exit(1);
  }
  const identity = verifyResult.identity;
  const motebitId = identity.motebit_id;
  const publicKeyHex = identity.identity.public_key;
  log(`Identity verified: ${motebitId}`);

  // 2. Build tool registry — one tool only (read_url)
  const registry = new InMemoryToolRegistry();
  registry.register(readUrlDefinition, createReadUrlHandler());

  // 3. Open database + create runtime
  const dbDir = path.dirname(path.resolve(config.dbPath));
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const moteDb = await openMotebitDatabase(path.resolve(config.dbPath));

  const storage: StorageAdapters = {
    eventStore: moteDb.eventStore,
    memoryStorage: moteDb.memoryStorage,
    identityStorage: moteDb.identityStorage,
    auditLog: moteDb.auditLog,
    stateSnapshot: moteDb.stateSnapshot,
    toolAuditSink: moteDb.toolAuditSink,
    conversationStore: moteDb.conversationStore,
    agentTrustStore: moteDb.agentTrustStore,
  };

  const govConfig =
    identity.governance != null ? governanceToPolicyConfig(identity.governance) : null;
  const policyOverrides = {
    ...(govConfig ?? {}),
    maxRiskAuto: parseRiskLevel("R3_EXECUTE"),
    requireApprovalAbove: parseRiskLevel("R3_EXECUTE"),
  };

  const runtime = new MotebitRuntime(
    { motebitId, policy: { ...policyOverrides } },
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  await runtime.init();
  log("Runtime initialized (tool server mode — read_url only)");

  // 4. Wire handleAgentTask — direct tool execution with signed receipts
  let handleAgentTask:
    | ((
        prompt: string,
        options?: { delegatedScope?: string; relayTaskId?: string },
      ) => AsyncGenerator<
        | { type: "text"; text: string }
        | { type: "task_result"; receipt: Record<string, unknown> }
        | { type: string; [key: string]: unknown }
      >)
    | undefined;

  if (config.privateKeyHex) {
    const privateKey = fromHex(config.privateKeyHex);
    handleAgentTask = async function* (
      prompt: string,
      options?: { delegatedScope?: string; relayTaskId?: string },
    ) {
      const taskId = crypto.randomUUID();
      const submittedAt = Date.now();

      let result: { ok: boolean; data?: unknown; error?: string };
      try {
        result = await runtime.getToolRegistry().execute("read_url", { url: prompt });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: msg };
      }
      const completedAt = Date.now();

      const resultStr = result.ok
        ? typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data ?? null)
        : (result.error ?? "error");
      const enc = new TextEncoder();
      const promptHash = await sha256(enc.encode(prompt));
      const resultHash = await sha256(enc.encode(resultStr));

      const receipt: Record<string, unknown> = {
        task_id: taskId,
        motebit_id: motebitId,
        device_id: "read-url-service",
        submitted_at: submittedAt,
        completed_at: completedAt,
        status: result.ok ? ("completed" as const) : ("failed" as const),
        result: resultStr,
        tools_used: ["read_url"],
        memories_formed: 0,
        prompt_hash: promptHash,
        result_hash: resultHash,
        ...(options?.relayTaskId ? { relay_task_id: options.relayTaskId } : {}),
      };

      const signed = await signExecutionReceipt(
        receipt as Parameters<typeof signExecutionReceipt>[0],
        privateKey,
      );
      log(`receipt=${signed.signature.slice(0, 12)}… url="${prompt.slice(0, 60)}"`);
      yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
    };
    log("Agent task handler enabled (receipts will be signed)");
  }

  // 5. Wire deps + start server
  const deps = wireServerDeps(runtime, {
    motebitId,
    publicKeyHex,
    identityFileContent: identityContent,
    embedText,
    verifySignedToken,
    handleAgentTask,
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
  });

  await startServiceServer(deps, {
    name: `motebit-read-url-${motebitId.slice(0, 8)}`,
    port: config.port,
    motebitType: "service",
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
    publicEndpointUrl: config.publicUrl,
    onStart: (port, toolCount) => {
      log(`MCP server running on http://localhost:${port} (SSE). ${toolCount} tools exposed.`);
    },
    onStop: () => {
      log("Shutting down...");
      runtime.stop();
      moteDb.close();
    },
    log,
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
