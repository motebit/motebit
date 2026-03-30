/**
 * Encrypted wrapper for PlanSyncRemoteAdapter.
 *
 * Mirrors EncryptedConversationSyncAdapter: encrypts sensitive fields
 * (title, description, prompt, result_summary, error_message) before push,
 * decrypts after pull. The relay stores opaque ciphertext — it can still
 * index by plan_id, motebit_id, status, and timestamps without decryption.
 */

import type { SyncPlan, SyncPlanStep } from "@motebit/sdk";
import { encrypt, decrypt, type EncryptedPayload } from "@motebit/crypto";
import type { PlanSyncRemoteAdapter } from "./plan-sync.js";

export interface EncryptedPlanAdapterConfig {
  /** The underlying remote adapter to wrap */
  inner: PlanSyncRemoteAdapter;
  /** 256-bit symmetric key for this motebit (same key as event/conversation encryption) */
  key: Uint8Array;
}

// Portable base64 helpers (same as encrypted-adapter.ts)
function toBase64(arr: Uint8Array): string {
  if (typeof globalThis.Buffer !== "undefined") {
    return globalThis.Buffer.from(arr).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]!);
  }
  return btoa(binary);
}

function fromBase64(str: string): Uint8Array {
  if (typeof globalThis.Buffer !== "undefined") {
    return new Uint8Array(globalThis.Buffer.from(str, "base64"));
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Marker prefix for encrypted strings — allows graceful handling of mixed encrypted/plaintext data. */
const ENCRYPTED_PREFIX = "\0ENC:";

async function encryptString(value: string | null, key: Uint8Array): Promise<string | null> {
  if (value == null || value === "") return value;
  const plaintext = new TextEncoder().encode(value);
  const encrypted = await encrypt(plaintext, key);
  const packed = JSON.stringify({
    c: toBase64(encrypted.ciphertext),
    n: toBase64(encrypted.nonce),
    t: toBase64(encrypted.tag),
  });
  return ENCRYPTED_PREFIX + packed;
}

async function decryptString(value: string | null, key: Uint8Array): Promise<string | null> {
  if (value == null || value === "") return value;
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // plaintext passthrough (backward compat)
  const packed = value.slice(ENCRYPTED_PREFIX.length);
  const data = JSON.parse(packed) as { c: string; n: string; t: string };
  const encrypted: EncryptedPayload = {
    ciphertext: fromBase64(data.c),
    nonce: fromBase64(data.n),
    tag: fromBase64(data.t),
  };
  const plaintext = await decrypt(encrypted, key);
  return new TextDecoder().decode(plaintext);
}

/**
 * Wraps a PlanSyncRemoteAdapter with field-level encryption.
 *
 * Encrypted fields: title, description, prompt, result_summary, error_message.
 * Cleartext fields: plan_id, motebit_id, status, timestamps, ordinal, step_id —
 * these are needed for relay indexing and conflict resolution.
 */
export class EncryptedPlanSyncAdapter implements PlanSyncRemoteAdapter {
  private inner: PlanSyncRemoteAdapter;
  private key: Uint8Array;

  constructor(config: EncryptedPlanAdapterConfig) {
    this.inner = config.inner;
    this.key = config.key;
  }

  async pushPlans(motebitId: string, plans: SyncPlan[]): Promise<number> {
    const encrypted = await Promise.all(plans.map((p) => this.encryptPlan(p)));
    return this.inner.pushPlans(motebitId, encrypted);
  }

  async pullPlans(motebitId: string, since: number): Promise<SyncPlan[]> {
    const encrypted = await this.inner.pullPlans(motebitId, since);
    return Promise.all(encrypted.map((p) => this.decryptPlan(p)));
  }

  async pushSteps(motebitId: string, steps: SyncPlanStep[]): Promise<number> {
    const encrypted = await Promise.all(steps.map((s) => this.encryptStep(s)));
    return this.inner.pushSteps(motebitId, encrypted);
  }

  async pullSteps(motebitId: string, since: number): Promise<SyncPlanStep[]> {
    const encrypted = await this.inner.pullSteps(motebitId, since);
    return Promise.all(encrypted.map((s) => this.decryptStep(s)));
  }

  private async encryptPlan(plan: SyncPlan): Promise<SyncPlan> {
    return {
      ...plan,
      title: (await encryptString(plan.title, this.key)) ?? plan.title,
    };
  }

  private async decryptPlan(plan: SyncPlan): Promise<SyncPlan> {
    return {
      ...plan,
      title: (await decryptString(plan.title, this.key)) ?? plan.title,
    };
  }

  private async encryptStep(step: SyncPlanStep): Promise<SyncPlanStep> {
    return {
      ...step,
      description: (await encryptString(step.description, this.key)) ?? step.description,
      prompt: (await encryptString(step.prompt, this.key)) ?? step.prompt,
      result_summary: await encryptString(step.result_summary, this.key),
      error_message: await encryptString(step.error_message, this.key),
    };
  }

  private async decryptStep(step: SyncPlanStep): Promise<SyncPlanStep> {
    return {
      ...step,
      description: (await decryptString(step.description, this.key)) ?? step.description,
      prompt: (await decryptString(step.prompt, this.key)) ?? step.prompt,
      result_summary: await decryptString(step.result_summary, this.key),
      error_message: await decryptString(step.error_message, this.key),
    };
  }
}
