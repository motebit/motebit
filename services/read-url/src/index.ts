/**
 * Motebit Read-URL Service (Charlie)
 *
 * A minimal tool server exposing only read_url via MCP.
 * Used as the second hop in multi-hop delegation: Alice → Bob → Charlie.
 *
 * ### Identity lifecycle
 *
 * The service self-bootstraps its motebit identity on first boot via
 * `bootstrapServiceIdentity()` from `@motebit/core-identity` — same
 * shared protocol every other surface (desktop/mobile/web/spatial/cli)
 * uses, just with filesystem-backed storage targeting the data dir.
 *
 * First boot under a fresh Fly volume:
 *   1. `/data/motebit.json` doesn't exist → bootstrap generates a
 *      fresh Ed25519 keypair, creates a motebit_id, persists both
 *   2. `/data/motebit.md` is written as a signed canonical identity
 *      file for inbound callers that want to verify our identity
 *
 * Every subsequent boot:
 *   1. `/data/motebit.json` + `/data/motebit.key` already exist →
 *      reload
 *   2. `/data/motebit.md` is regenerated with a fresh `created_at`
 *      timestamp but the same motebit_id / keypair (signature differs
 *      only in the field that changes)
 *
 * The volume is the persistence layer. Losing it = losing this
 * agent's accumulated trust. Fly volume snapshots are the backup
 * primitive — same as any persistent-state service.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import type { StorageAdapters } from "@motebit/runtime";
import { openMotebitDatabase } from "@motebit/persistence";
import { InMemoryToolRegistry, readUrlDefinition, createReadUrlHandler } from "@motebit/tools";
import { wireServerDeps, startServiceServer } from "@motebit/mcp-server";
import { bootstrapServiceIdentity } from "@motebit/core-identity";
import { generate, parseRiskLevel } from "@motebit/identity-file";
import { verifySignedToken, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import { embedText } from "@motebit/memory-graph";
import { loadConfig, fromHex } from "./helpers.js";

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const serviceName = "motebit-read-url";

  // 1. Bootstrap identity from the persistent data dir (generates on
  //    first boot, reloads on subsequent boots). Same shared protocol
  //    every other surface uses — filesystem is the storage adapter.
  const bootstrap = await bootstrapServiceIdentity({
    dataDir: path.resolve(config.dataDir),
    serviceName,
  });
  const { motebitId, deviceId, publicKeyHex, privateKeyHex } = bootstrap;
  log(
    `Identity ${bootstrap.isFirstLaunch ? "generated" : "loaded"}: ${motebitId} ` +
      `(data dir: ${config.dataDir})`,
  );

  // 2. Emit the canonical signed motebit.md identity file from the
  //    bootstrapped state. This is what wireServerDeps serves to
  //    inbound callers that want to verify the service's identity.
  //    Regenerating on every boot is deterministic except for the
  //    `created_at` field (intentionally fresh).
  const privateKeyBytes = fromHex(privateKeyHex);
  const identityContent = await generate(
    {
      motebitId,
      ownerId: serviceName,
      publicKeyHex,
      devices: [
        {
          device_id: deviceId,
          name: serviceName,
          public_key: publicKeyHex,
          registered_at: new Date().toISOString(),
        },
      ],
      service: {
        type: "service",
        service_name: "Read URL",
        service_description: "Minimal URL reader (second hop in multi-hop delegation proof)",
        capabilities: ["read_url"],
      },
    },
    privateKeyBytes,
  );
  fs.writeFileSync(bootstrap.suggestedIdentityPath, identityContent, "utf-8");

  // 3. Build tool registry — one tool only (read_url)
  const registry = new InMemoryToolRegistry();
  registry.register(readUrlDefinition, createReadUrlHandler());

  // 4. Open database + create runtime
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
    planStore: moteDb.planStore,
    gradientStore: moteDb.gradientStore as unknown as StorageAdapters["gradientStore"],
    agentTrustStore: moteDb.agentTrustStore,
    serviceListingStore: moteDb.serviceListingStore,
    budgetAllocationStore: moteDb.budgetAllocationStore,
    settlementStore: moteDb.settlementStore,
    latencyStatsStore: moteDb.latencyStatsStore,
    credentialStore: moteDb.credentialStore,
    approvalStore: moteDb.approvalStore,
  };

  const policyOverrides = {
    maxRiskAuto: parseRiskLevel("R3_EXECUTE"),
    requireApprovalAbove: parseRiskLevel("R3_EXECUTE"),
  };

  const runtime = new MotebitRuntime(
    { motebitId, policy: { ...policyOverrides } },
    { storage, renderer: new NullRenderer(), tools: registry },
  );
  await runtime.init();
  log("Runtime initialized (tool server mode — read_url only)");

  // 5. Wire handleAgentTask — direct tool execution with signed receipts
  const handleAgentTask = async function* (
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
      device_id: deviceId,
      submitted_at: submittedAt,
      completed_at: completedAt,
      status: result.ok ? ("completed" as const) : ("failed" as const),
      result: resultStr,
      tools_used: ["read_url"],
      memories_formed: 0,
      prompt_hash: promptHash,
      result_hash: resultHash,
      ...(options?.relayTaskId ? { relay_task_id: options.relayTaskId } : {}),
      // Delegated scope — must be included before signing so it's in the canonical form
      ...(options?.delegatedScope ? { delegated_scope: options.delegatedScope } : {}),
    };

    const signed = await signExecutionReceipt(
      receipt as Parameters<typeof signExecutionReceipt>[0],
      privateKeyBytes,
      fromHex(publicKeyHex),
    );
    log(`receipt=${signed.signature.slice(0, 12)}… url="${prompt.slice(0, 60)}"`);
    yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
  };

  // 6. Wire deps + start server
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
      // Zero the private key bytes from memory on shutdown.
      privateKeyBytes.fill(0);
    },
    log,
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
