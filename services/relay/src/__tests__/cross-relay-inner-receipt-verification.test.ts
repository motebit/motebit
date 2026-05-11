/**
 * Cross-relay inner-receipt verification — end-to-end composition proof.
 *
 * Demonstrates the v1.1 producer-consumer arc composes through the actual
 * HTTP boundary with real cryptographic signatures, simulating
 *
 *   "Relay B (or any third party) verifies Relay A's claims without
 *    trusting Relay A":
 *
 *   1. TOFU bootstrap — fetch /.well-known/motebit-transparency.json,
 *      verify its self-signature, pin the relay's identity key.
 *   2. Fetch /api/v1/execution/:motebitId/:goalId (a v1.1 execution-ledger).
 *   3. Verify the X-Motebit-Content-Manifest outer envelope against the
 *      pinned anchor key (proves relay attestation of bundle assembly).
 *   4. Recursively verify each inner ExecutionReceipt's Ed25519 signature
 *      (proves each agent's individual attestation of work performed).
 *
 *   Tamper paths assert fail-closed behaviour at each layer.
 *
 * The primitives are exhaustively unit-tested in:
 *   - `@motebit/crypto` (verifyContentArtifact, verifyReceipt)
 *   - `@motebit/state-export-client` (verifyInnerSignedReceipts, verifyTransparencyDeclaration)
 *
 * This file pins the *composition* — the arc holds when wired through
 * the real HTTP route with the real `relay_receipts.receipt_json` archive.
 * The same shape generalizes to a live cross-cloud script targeting
 * `motebit-sync-stg.fly.dev` + `motebit-sync-stg-b.fly.dev`; the
 * deterministic in-CI version lands first because every PR gets the proof.
 *
 * Doctrine: docs/doctrine/nist-alignment.md §8; spec/execution-ledger-v1.md
 * §4.3; spec/relay-transparency-v1.md.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { EventType, PlanStatus, StepStatus, asMotebitId, asGoalId, asPlanId } from "@motebit/sdk";
import type { EventLogEntry, Plan, PlanStep } from "@motebit/sdk";
import { fromBase64Url } from "@motebit/encryption";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  verifyContentArtifact,
  type ContentArtifactManifest,
} from "@motebit/crypto";
import type { ExecutionReceipt } from "@motebit/protocol";
import {
  verifyInnerSignedReceipts,
  verifyTransparencyDeclaration,
  type SignedTransparencyDeclaration,
} from "@motebit/state-export-client";
import { AUTH_HEADER, createTestRelay as _createTestRelay } from "./test-helpers.js";

const MOTEBIT_ID = "test-mote-xrelay";
const GOAL_ID = "goal-xrelay-1";
const PLAN_ID = "plan-xrelay-1";

const createTestRelay = () => _createTestRelay({ enableDeviceAuth: false });

function makeEvent(
  motebitId: string,
  clock: number,
  eventType: string,
  payload: Record<string, unknown>,
): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    device_id: "test-device",
    timestamp: 1000 + clock * 100,
    event_type: eventType as EventType,
    payload,
    version_clock: clock,
    tombstoned: false,
  };
}

async function pushEvents(relay: SyncRelay, motebitId: string, events: EventLogEntry[]) {
  const res = await relay.app.request(`/sync/${motebitId}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(200);
}

function savePlan(relay: SyncRelay): Plan {
  const plan: Plan = {
    plan_id: asPlanId(PLAN_ID),
    goal_id: asGoalId(GOAL_ID),
    motebit_id: asMotebitId(MOTEBIT_ID),
    title: "Cross-relay verification plan",
    status: PlanStatus.Completed,
    created_at: 1000,
    updated_at: 2000,
    current_step_index: 0,
    total_steps: 1,
  };
  relay.moteDb.planStore.savePlan(plan);
  return plan;
}

function saveStep(relay: SyncRelay, delegationTaskId: string): PlanStep {
  const step: PlanStep = {
    step_id: "step-0",
    plan_id: asPlanId(PLAN_ID),
    ordinal: 0,
    description: "Delegated step",
    prompt: "Delegate to a downstream motebit",
    depends_on: [],
    optional: false,
    status: StepStatus.Completed,
    result_summary: "Delegate completed",
    error_message: null,
    tool_calls_made: 1,
    started_at: 1500,
    completed_at: 1800,
    retry_count: 0,
    updated_at: 1800,
    delegation_task_id: delegationTaskId,
  };
  relay.moteDb.planStore.saveStep(step);
  return step;
}

interface SignedFixture {
  receipt: ExecutionReceipt;
  taskId: string;
  delegateMotebitId: string;
  delegatePublicKeyHex: string;
}

/**
 * Build a real Ed25519-signed ExecutionReceipt and archive it through
 * the canonical path the relay uses when a delegated motebit submits a
 * receipt — `persistReceiptChain`. The byte-identical archive is what
 * the v1.1 state-export reads from to populate `signed_receipts`.
 */
async function seedSignedReceipt(relay: SyncRelay): Promise<SignedFixture> {
  const { persistReceiptChain } = await import("../receipts-store.js");
  const kp = await generateKeypair();
  const taskId = "task-xrelay-delegated";
  const delegateMotebitId = "delegate-mote-xrelay";
  const unsigned = {
    task_id: taskId,
    motebit_id: delegateMotebitId,
    device_id: "delegate-device-xrelay",
    submitted_at: 1100,
    completed_at: 1400,
    status: "completed",
    result: "ok",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "0".repeat(64),
    result_hash: "1".repeat(64),
    public_key: bytesToHex(kp.publicKey),
  } as unknown as Parameters<typeof signExecutionReceipt>[0];
  const signed = await signExecutionReceipt(unsigned, kp.privateKey);
  persistReceiptChain(
    relay.moteDb.db,
    signed as unknown as Parameters<typeof persistReceiptChain>[1],
  );
  return {
    receipt: signed,
    taskId,
    delegateMotebitId,
    delegatePublicKeyHex: bytesToHex(kp.publicKey),
  };
}

async function seedLedgerEvents(
  relay: SyncRelay,
  delegationTaskId: string,
  receipt: ExecutionReceipt,
) {
  savePlan(relay);
  saveStep(relay, delegationTaskId);
  await pushEvents(relay, MOTEBIT_ID, [
    makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, { goal_id: GOAL_ID }),
    makeEvent(MOTEBIT_ID, 2, EventType.PlanCreated, {
      plan_id: PLAN_ID,
      goal_id: GOAL_ID,
      total_steps: 1,
    }),
    makeEvent(MOTEBIT_ID, 3, EventType.PlanStepDelegated, {
      plan_id: PLAN_ID,
      step_id: "step-0",
      ordinal: 0,
      task_id: delegationTaskId,
    }),
    makeEvent(MOTEBIT_ID, 4, EventType.AgentTaskCompleted, {
      task_id: delegationTaskId,
      goal_id: GOAL_ID,
      status: "completed",
      tools_used: ["web_search"],
      receipt: receipt as unknown as Record<string, unknown>,
    }),
    makeEvent(MOTEBIT_ID, 5, EventType.GoalCompleted, {
      goal_id: GOAL_ID,
      status: "completed",
    }),
  ]);
}

function decodeManifestHeader(headerValue: string | null): ContentArtifactManifest {
  if (headerValue == null || headerValue === "") {
    throw new Error("X-Motebit-Content-Manifest header missing");
  }
  const manifestBytes = fromBase64Url(headerValue);
  return JSON.parse(new TextDecoder().decode(manifestBytes)) as ContentArtifactManifest;
}

describe("cross-relay inner-receipt verification — end-to-end composition", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("verifies a v1.1 execution-ledger end-to-end as a third party would (TOFU → outer → inner)", async () => {
    const fixture = await seedSignedReceipt(relay);
    await seedLedgerEvents(relay, fixture.taskId, fixture.receipt);

    // === Phase 1 — TOFU bootstrap ===
    // A third-party verifier knows only the relay's URL. It fetches the
    // public transparency endpoint and verifies the declaration's
    // self-signature; the result is a pinned `TransparencyAnchor`
    // committing the relay to a specific Ed25519 public key.
    const tRes = await relay.app.request("/.well-known/motebit-transparency.json", {
      method: "GET",
    });
    expect(tRes.status).toBe(200);
    const declaration = (await tRes.json()) as SignedTransparencyDeclaration;
    const tofu = await verifyTransparencyDeclaration(declaration);
    expect(tofu.ok).toBe(true);
    if (!tofu.ok) throw new Error(`tofu failed: ${tofu.reason}`);
    const pinnedRelayPublicKey = tofu.anchor.relayPublicKeyHex;

    // === Phase 2 — Fetch the v1.1 execution-ledger ===
    const lRes = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(lRes.status).toBe(200);
    const bodyBytes = new Uint8Array(await lRes.arrayBuffer());
    const manifest = decodeManifestHeader(lRes.headers.get("X-Motebit-Content-Manifest"));

    // === Phase 3 — Outer envelope verify ===
    // Relay's manifest claims to have produced these bytes. The producer
    // key in the manifest must match the key we pinned in Phase 1 — if
    // the relay swapped identity since bootstrap, this assertion catches
    // it. Then verifyContentArtifact confirms the bytes + signature.
    expect(manifest.producer_public_key).toBe(pinnedRelayPublicKey);
    const outer = await verifyContentArtifact(manifest, bodyBytes);
    expect(outer.valid).toBe(true);
    expect(outer.reason).toBeUndefined();

    // === Phase 4 — Inner recursive verify ===
    // The relay's outer attestation says "I assembled these bytes."
    // The inner attestation says "these specific receipts were signed by
    // the motebits that did the work." A relay cannot fabricate inner
    // signatures without holding the delegate motebits' private keys —
    // verifyInnerSignedReceipts proves this without trusting the relay.
    const body = JSON.parse(new TextDecoder().decode(bodyBytes)) as Record<string, unknown>;
    expect(body.spec).toBe("motebit/execution-ledger@1.1");
    const inner = await verifyInnerSignedReceipts(body);
    expect(inner.applicable).toBe(true);
    expect(inner.allValid).toBe(true);
    expect(inner.totalCount).toBe(1);
    expect(inner.results[0]?.valid).toBe(true);
    expect(inner.results[0]?.taskId).toBe(fixture.taskId);
    expect(inner.results[0]?.motebitId).toBe(fixture.delegateMotebitId);
  });

  it("inner-receipt signature tamper flips verifyInnerSignedReceipts to signature_invalid", async () => {
    const fixture = await seedSignedReceipt(relay);
    await seedLedgerEvents(relay, fixture.taskId, fixture.receipt);

    const lRes = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(lRes.status).toBe(200);
    const bodyText = await lRes.text();
    const body = JSON.parse(bodyText) as { signed_receipts: string[] };

    // Tamper one byte of the inner receipt's hex signature. The signed
    // canonical JSON still parses; verifyReceipt recomputes the digest
    // and checks the signature against the embedded public key, which
    // now disagrees → signature_invalid.
    const original = body.signed_receipts[0]!;
    const parsed = JSON.parse(original) as { signature: string };
    const sig = parsed.signature;
    const tamperedSig = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    const tamperedReceipt = JSON.stringify({ ...parsed, signature: tamperedSig });
    const tamperedBody = { ...body, signed_receipts: [tamperedReceipt] };

    const inner = await verifyInnerSignedReceipts(tamperedBody);
    expect(inner.applicable).toBe(true);
    expect(inner.allValid).toBe(false);
    expect(inner.results[0]?.valid).toBe(false);
    expect(inner.results[0]?.reason).toBe("signature_invalid");
  });

  it("outer body tamper flips verifyContentArtifact to content_hash_mismatch (catches before inner verify)", async () => {
    const fixture = await seedSignedReceipt(relay);
    await seedLedgerEvents(relay, fixture.taskId, fixture.receipt);

    const lRes = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(lRes.status).toBe(200);
    const bodyBytes = new Uint8Array(await lRes.arrayBuffer());
    const manifest = decodeManifestHeader(lRes.headers.get("X-Motebit-Content-Manifest"));

    // Flip one byte. The relay-signed manifest's content_hash no longer
    // matches the received bytes → outer envelope fails. A verifier that
    // honors the layered contract refuses to recurse into the inner body
    // when the outer is invalid — the bytes can't be trusted to even
    // BE the relay's claim.
    const tampered = new Uint8Array(bodyBytes);
    tampered[0] = tampered[0]! ^ 0x01;
    const outer = await verifyContentArtifact(manifest, tampered);
    expect(outer.valid).toBe(false);
    expect(outer.reason).toBe("content_hash_mismatch");
  });
});
