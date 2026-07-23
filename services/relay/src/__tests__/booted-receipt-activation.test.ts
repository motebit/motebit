/**
 * BOOTED-ARTIFACT activation conformance for the action→receipt pipeline
 * link (docs/doctrine/composition-preserves-enforcement.md — the per-link
 * behavioral-severing ladder; rung 3 of the pipeline-link ladder).
 *
 * The guarantee this link carries: an executed action settles ONLY on a
 * signed ExecutionReceipt that (a) verifies under Ed25519 and (b) is bound
 * to the task's actual worker. The in-process slices of this link are the
 * two named incidents #357 (the transcript producer went dormant because
 * the composition root didn't wire signing keys) and #358 (a minted receipt
 * was never threaded onto the result). Those prove the DELEGATOR-side egress.
 * This rung proves the RELAY-side receipt gate — the settlement-authorizing
 * enforcement point — from OUTSIDE the deployed artifact, over real HTTP.
 *
 * The money-runtime-activation suite's header records that the relay-side
 * receipt gate (`POST /agent/:id/task/:taskId/result` → `handleReceiptIngestion`)
 * had no booted rung: it was only ever exercised in-process. This suite adds
 * it. It boots the compiled `node dist/server.js` (the run.sh exec line),
 * provisions a worker over the real HTTP API with the operator master token,
 * queues a free self-delegation task, then POSTs receipts at the real
 * `/result` route and asserts the artifact's own gate:
 *
 *  - accept-half: a valid receipt signed by the worker, bound to the task,
 *    is accepted (200) — the action→receipt link intact in the artifact;
 *  - forgery-half: a byte-tampered signature is refused (403) — no
 *    settlement without a valid Ed25519 receipt (the canonical gate).
 *
 * Transport auth for the /result POST uses the operator master token, so the
 * only variable under test is the receipt body — the identity→authz link
 * (device-token audience binding) is a separate rung and is deliberately not
 * re-proven here.
 *
 * Discriminating power (severing run, recorded in the PR): sever the verify
 * gate in tasks.ts (`let receiptValid = await verifyExecutionReceipt(...)` →
 * `let receiptValid = true`) + rebuild dist → the forgery-half flips to 200
 * (`expected 200 to be 403`) while the accept-half holds. The gate goes red
 * exactly when the artifact stops verifying the signature.
 *
 * ── The needle-invisible fail-open this rung surfaced (deferred-with-trigger)
 * `handleReceiptIngestion` looks up the verifying key from `receipt.motebit_id`
 * (a receipt-body field) and, on a first-pass miss against the registered key,
 * falls back to the key EMBEDDED in the receipt — heal-writing it onto
 * `agent_registry.public_key` for `receipt.motebit_id`. An agent that self-
 * delegates can mint a `task:result` token for its own task, then POST a
 * receipt claiming a VICTIM's `motebit_id` with its own key embedded; the
 * fallback verifies against the embedded key and OVERWRITES the victim's
 * registered key — a cross-identity registry-key hijack. No static needle
 * covers it (every wiring string is present; the missing guard is a runtime
 * condition). The naive fix — bind `receipt.motebit_id === entry.task.motebit_id`
 * — is WRONG: routed delegation legitimately separates the task TARGET
 * (`task.motebit_id`) from the EXECUTOR (`receipt.motebit_id`); binding them
 * reds ~19 delegation/credential tests (A→B where B executes A's routed task).
 * The correct invariant is subtler and touches the rotation path — the heal-
 * write must be bound to key material already associated with
 * `receipt.motebit_id` (a registered DEVICE of that identity), never to an
 * arbitrary self-signed key, or the overwrite-an-existing-key branch must be
 * removed (heal only when no key is on file). Deferred-with-trigger to the
 * embedded-key-fallback doctrine seam (verify-family-fail-closed) — this is a
 * money/security path, and the arc records the gap rather than shipping a hasty
 * rebind. Recorded in docs/doctrine/composition-preserves-enforcement.md.
 *
 * Rung choice: compiled-dist only — the source-vs-dist differential is #359's
 * suite's job; this suite targets link behavior and keeps each link's
 * marginal boot cost low.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeypair, bytesToHex, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import {
  BOOT_TIMEOUT_MS,
  DIST_TIER,
  bootRealEntry,
  killBootedEntry,
  type BootedEntry,
} from "./booted-entry-harness.js";

const MASTER_TOKEN = "booted-receipt-master-token";

interface Provisioned {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_TOKEN}` };

/** Provision identity + device over the REAL HTTP API, as an operator would. */
async function provisionDevice(baseUrl: string): Promise<Provisioned> {
  const keypair = await generateKeypair();
  const identityRes = await fetch(`${baseUrl}/identity`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  if (!identityRes.ok) throw new Error(`provisioning /identity failed: ${identityRes.status}`);
  const identity = (await identityRes.json()) as { motebit_id: string };
  const deviceRes = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      motebit_id: identity.motebit_id,
      device_name: "booted-receipt-probe",
      public_key: bytesToHex(keypair.publicKey),
    }),
  });
  if (!deviceRes.ok) throw new Error(`provisioning /device/register failed: ${deviceRes.status}`);
  const device = (await deviceRes.json()) as { device_id: string };
  return {
    motebitId: identity.motebit_id,
    deviceId: device.device_id,
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
  };
}

/** Queue a free self-delegation task and return its id. Unlisted worker ⇒
 * `getAgentPricing` is null ⇒ the x402 gate short-circuits (free); the
 * self-delegation submission carve-out means no P2P proof is required. */
async function queueSelfTask(baseUrl: string, worker: Provisioned): Promise<string> {
  const res = await fetch(`${baseUrl}/agent/${worker.motebitId}/task`, {
    method: "POST",
    headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: "booted-receipt probe",
      submitted_by: worker.motebitId,
      target_agent: worker.motebitId,
    }),
  });
  if (res.status !== 201)
    throw new Error(`task submission failed: ${res.status} ${await res.text()}`);
  const { task_id } = (await res.json()) as { task_id: string };
  return task_id;
}

/** Build + sign an ExecutionReceipt bound to `taskId` and to `worker`. */
async function signReceipt(taskId: string, worker: Provisioned): Promise<Record<string, unknown>> {
  const enc = new TextEncoder();
  const now = Date.now();
  const body = {
    task_id: taskId,
    relay_task_id: taskId,
    motebit_id: worker.motebitId,
    public_key: bytesToHex(worker.publicKey),
    device_id: worker.deviceId,
    submitted_at: now - 1000,
    completed_at: now,
    status: "completed" as const,
    result: "ok",
    tools_used: [] as string[],
    memories_formed: 0,
    prompt_hash: await sha256(enc.encode("booted-receipt probe")),
    result_hash: await sha256(enc.encode("ok")),
  };
  const signed = await signExecutionReceipt(
    body as unknown as Parameters<typeof signExecutionReceipt>[0],
    worker.privateKey,
    worker.publicKey,
  );
  return signed as unknown as Record<string, unknown>;
}

async function postResult(
  baseUrl: string,
  worker: Provisioned,
  taskId: string,
  receipt: Record<string, unknown>,
): Promise<number> {
  const res = await fetch(`${baseUrl}/agent/${worker.motebitId}/task/${taskId}/result`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(receipt),
  });
  return res.status;
}

describe("booted entry — action→receipt link (settlement gated on a bound, valid receipt in the deployed artifact)", () => {
  let booted: BootedEntry | null = null;
  let worker: Provisioned;

  beforeAll(async () => {
    booted = await bootRealEntry(DIST_TIER, { MOTEBIT_API_TOKEN: MASTER_TOKEN });
    worker = await provisionDevice(booted.baseUrl);
  }, BOOT_TIMEOUT_MS);

  afterAll(() => {
    killBootedEntry(booted);
  });

  it("accepts a valid receipt signed by the task's worker (accept-half)", async () => {
    const taskId = await queueSelfTask(booted!.baseUrl, worker);
    const receipt = await signReceipt(taskId, worker);
    // Repair pointer on failure: a non-200 here means the deployed artifact's
    // receipt gate (handleReceiptIngestion in services/relay/src/tasks.ts)
    // rejected a well-formed receipt bound to its own task — the action→receipt
    // link is severed in the artifact.
    expect(await postResult(booted!.baseUrl, worker, taskId, receipt)).toBe(200);
  });

  it("refuses a byte-tampered signature (forgery-half — no settlement without a valid Ed25519 receipt)", async () => {
    const taskId = await queueSelfTask(booted!.baseUrl, worker);
    const receipt = await signReceipt(taskId, worker);
    // Flip the leading signature char — same canonical body, broken signature.
    const sig = receipt.signature as string;
    const tampered = { ...receipt, signature: (sig[0] === "A" ? "B" : "A") + sig.slice(1) };
    expect(await postResult(booted!.baseUrl, worker, taskId, tampered)).toBe(403);
  });
});
