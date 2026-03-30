/**
 * Encrypted wrapper for ConversationSyncRemoteAdapter.
 *
 * Mirrors the EncryptedEventStoreAdapter pattern: encrypts sensitive fields
 * (content, title, summary, tool_calls) before push, decrypts after pull.
 * The relay stores opaque ciphertext — it can still index by conversation_id,
 * motebit_id, and timestamps without decryption.
 */

import type { SyncConversation, SyncConversationMessage } from "@motebit/sdk";
import { encrypt, decrypt, type EncryptedPayload } from "@motebit/crypto";
import type { ConversationSyncRemoteAdapter } from "./conversation-sync.js";

export interface EncryptedConversationAdapterConfig {
  /** The underlying remote adapter to wrap */
  inner: ConversationSyncRemoteAdapter;
  /** 256-bit symmetric key for this motebit (same key as event encryption) */
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
 * Wraps a ConversationSyncRemoteAdapter with field-level encryption.
 *
 * Encrypted fields: content, title, summary, tool_calls.
 * Cleartext fields: conversation_id, motebit_id, timestamps, role, message_count —
 * these are needed for relay indexing and conflict resolution.
 */
export class EncryptedConversationSyncAdapter implements ConversationSyncRemoteAdapter {
  private inner: ConversationSyncRemoteAdapter;
  private key: Uint8Array;

  constructor(config: EncryptedConversationAdapterConfig) {
    this.inner = config.inner;
    this.key = config.key;
  }

  async pushConversations(motebitId: string, conversations: SyncConversation[]): Promise<number> {
    const encrypted = await Promise.all(conversations.map((c) => this.encryptConversation(c)));
    return this.inner.pushConversations(motebitId, encrypted);
  }

  async pullConversations(motebitId: string, since: number): Promise<SyncConversation[]> {
    const encrypted = await this.inner.pullConversations(motebitId, since);
    return Promise.all(encrypted.map((c) => this.decryptConversation(c)));
  }

  async pushMessages(motebitId: string, messages: SyncConversationMessage[]): Promise<number> {
    const encrypted = await Promise.all(messages.map((m) => this.encryptMessage(m)));
    return this.inner.pushMessages(motebitId, encrypted);
  }

  async pullMessages(
    motebitId: string,
    conversationId: string,
    since: number,
  ): Promise<SyncConversationMessage[]> {
    const encrypted = await this.inner.pullMessages(motebitId, conversationId, since);
    return Promise.all(encrypted.map((m) => this.decryptMessage(m)));
  }

  // --- Encrypt/decrypt helpers ---

  private async encryptConversation(conv: SyncConversation): Promise<SyncConversation> {
    return {
      ...conv,
      title: await encryptString(conv.title, this.key),
      summary: await encryptString(conv.summary, this.key),
    };
  }

  private async decryptConversation(conv: SyncConversation): Promise<SyncConversation> {
    return {
      ...conv,
      title: await decryptString(conv.title, this.key),
      summary: await decryptString(conv.summary, this.key),
    };
  }

  private async encryptMessage(msg: SyncConversationMessage): Promise<SyncConversationMessage> {
    return {
      ...msg,
      content: (await encryptString(msg.content, this.key)) ?? "",
      tool_calls: await encryptString(msg.tool_calls, this.key),
    };
  }

  private async decryptMessage(msg: SyncConversationMessage): Promise<SyncConversationMessage> {
    return {
      ...msg,
      content: (await decryptString(msg.content, this.key)) ?? "",
      tool_calls: await decryptString(msg.tool_calls, this.key),
    };
  }
}

/**
 * Standalone decryption for conversation messages received via WebSocket.
 * Decrypts encrypted fields; passes through unencrypted messages.
 */
export async function decryptConversationMessage(
  msg: SyncConversationMessage,
  key: Uint8Array,
): Promise<SyncConversationMessage> {
  return {
    ...msg,
    content: (await decryptString(msg.content, key)) ?? "",
    tool_calls: await decryptString(msg.tool_calls, key),
  };
}

/**
 * Standalone decryption for conversations received via WebSocket.
 * Decrypts encrypted fields; passes through unencrypted conversations.
 */
export async function decryptSyncConversation(
  conv: SyncConversation,
  key: Uint8Array,
): Promise<SyncConversation> {
  return {
    ...conv,
    title: await decryptString(conv.title, key),
    summary: await decryptString(conv.summary, key),
  };
}
