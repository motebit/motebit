/**
 * Cross-identity registry-key hijack — receipt ingestion must never let one
 * agent overwrite ANOTHER agent's registry key.
 *
 * `handleReceiptIngestion` (services/relay/src/tasks.ts) resolves the verifying
 * key from the receipt-body field `receipt.motebit_id`, and — as a convenience
 * to reconcile a registry key with the agent's own device key — falls back to
 * the key EMBEDDED in the receipt and HEAL-WRITES it onto
 * `agent_registry.public_key`. Unbound, that heal is a cross-identity hijack: a
 * self-delegating attacker mints a `task:result` token for ITS OWN task, then
 * POSTs a receipt whose body claims a VICTIM's `motebit_id` with the attacker's
 * OWN key embedded and signed. The old fallback verified against the embedded
 * (attacker) key and overwrote the victim's registry key — the attacker now
 * owns the victim's identity in the registry (settlement, credentials, trust).
 *
 * The fix binds the heal to key material ALREADY associated with
 * `receipt.motebit_id`: the embedded key must be a REGISTERED DEVICE of that
 * identity, or the fallback is skipped and the receipt fails closed. Legitimate
 * key rotation is the authenticated `/rotate-key` succession route (which
 * proves possession of the CURRENT key), never a receipt.
 *
 * SEVERING (recorded): drop the `embeddedIsRegisteredDevice` guard in
 * tasks.ts's fallback → the forged receipt verifies against the attacker's
 * embedded key and overwrites the victim's registry key → this test's
 * "unchanged" assertion flips red. The guard is the sole thing standing between
 * a self-signed embedded key and a victim's registry identity.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- security test needs direct crypto primitives
import { generateKeypair, bytesToHex, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
// eslint-disable-next-line no-restricted-imports -- the attacker mints its own bearer token
import { createSignedToken } from "@motebit/encryption";
import {
  createAgent,
  createTestRelay,
  JSON_AUTH,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";

function registryKey(relay: SyncRelay, motebitId: string): string | undefined {
  return (
    relay.moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined
  )?.public_key;
}

describe("receipt ingestion — cross-identity registry-key hijack is refused", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("an attacker's receipt claiming the victim's motebit_id with its own embedded key does NOT overwrite the victim's registry key", async () => {
    const victimKp = await generateKeypair();
    const attackerKp = await generateKeypair();
    const victimPubHex = bytesToHex(victimKp.publicKey);
    const attackerPubHex = bytesToHex(attackerKp.publicKey);

    // Victim: a registered agent with an established registry key (its own).
    const victim = await createAgent(relay, victimPubHex);
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: victim.motebitId,
        public_key: victimPubHex,
        endpoint_url: "http://localhost:1/mcp",
        capabilities: ["web_search"],
      }),
    });
    expect(registryKey(relay, victim.motebitId)).toBe(victimPubHex);

    // Attacker: its own identity + a task IT owns (self-delegation is free —
    // unlisted worker short-circuits pricing, self-delegation needs no proof).
    const attacker = await createAgent(relay, attackerPubHex);
    const taskRes = await relay.app.request(`/agent/${attacker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "hijack probe",
        submitted_by: attacker.motebitId,
        target_agent: attacker.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(taskRes.status).toBe(201);
    const { task_id } = (await taskRes.json()) as { task_id: string };

    // The attacker mints a task:result token for ITS OWN task — minimal
    // privilege, no operator credentials. The forgery is entirely in the body.
    const attackerToken = await createSignedToken(
      {
        mid: attacker.motebitId,
        did: attacker.deviceId,
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud: "task:result",
      },
      attackerKp.privateKey,
    );

    // Forge the receipt: claim the VICTIM as executor, embed the ATTACKER's key,
    // sign with the ATTACKER's key. The embedded key is NOT a device of the victim.
    const enc = new TextEncoder();
    const forged = await signExecutionReceipt(
      {
        task_id,
        relay_task_id: task_id,
        motebit_id: victim.motebitId,
        public_key: attackerPubHex,
        device_id: attacker.deviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "hijack",
        tools_used: [] as string[],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("hijack probe")),
        result_hash: await sha256(enc.encode("hijack")),
      } as unknown as Parameters<typeof signExecutionReceipt>[0],
      attackerKp.privateKey,
      attackerKp.publicKey,
    );

    const res = await relay.app.request(`/agent/${attacker.motebitId}/task/${task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${attackerToken}` },
      body: JSON.stringify(forged),
    });

    // The forged receipt is refused — it verifies against neither the victim's
    // registry key nor any registered device of the victim.
    expect(res.status).not.toBe(200);
    // The load-bearing assertion: the victim's registry key is UNCHANGED. Under
    // the severing (drop the device-membership guard) this flips to attackerPubHex.
    expect(registryKey(relay, victim.motebitId)).toBe(victimPubHex);
  });
});
