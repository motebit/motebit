/**
 * @motebit/desktop — Tauri app (Rust + webview)
 *
 * Thin platform shell around MotebitRuntime.
 * Provides Tauri-specific storage adapters and AI provider creation.
 */

import { MotebitRuntime } from "@motebit/runtime";
import type { TurnResult, StorageAdapters, StreamChunk, KeyringAdapter, OperatorModeResult, AuditLogSink } from "@motebit/runtime";
import { ThreeJSAdapter } from "@motebit/render-engine";
import {
  CloudProvider,
  OllamaProvider,
  resolveConfig,
  type MotebitPersonalityConfig,
} from "@motebit/ai-core";
import type { ToolAuditEntry } from "@motebit/sdk";
import { InMemoryEventStore } from "@motebit/event-log";
import { InMemoryMemoryStorage } from "@motebit/memory-graph";
import { InMemoryIdentityStorage } from "@motebit/core-identity";
import { InMemoryAuditLog } from "@motebit/privacy-layer";
import { TauriEventStore, TauriMemoryStorage, type InvokeFn } from "./tauri-storage.js";
export type { InvokeFn } from "./tauri-storage.js";

// Re-export runtime types for main.ts consumption
export type { TurnResult, StreamChunk, OperatorModeResult };

// === Tauri Command Interface ===

export interface TauriCommands {
  db_query(sql: string, params: unknown[]): Promise<unknown[]>;
  db_execute(sql: string, params: unknown[]): Promise<number>;
  keyring_get(key: string): Promise<string | null>;
  keyring_set(key: string, value: string): Promise<void>;
  keyring_delete(key: string): Promise<void>;
  read_config(): Promise<string>;
  write_config(json: string): Promise<void>;
}

// === Desktop AI Config ===

export interface DesktopAIConfig {
  provider: "anthropic" | "ollama";
  model?: string;
  apiKey?: string;
  personalityConfig?: MotebitPersonalityConfig;
  isTauri: boolean;
  invoke?: InvokeFn;
}

// === Tauri Keyring Adapter ===

class TauriKeyringAdapter implements KeyringAdapter {
  constructor(private invoke: InvokeFn) {}

  async get(key: string): Promise<string | null> {
    return this.invoke<string | null>("keyring_get", { key });
  }

  async set(key: string, value: string): Promise<void> {
    await this.invoke<void>("keyring_set", { key, value });
  }

  async delete(key: string): Promise<void> {
    await this.invoke<void>("keyring_delete", { key });
  }
}

// === Tauri Tool Audit Sink ===

class TauriToolAuditSink implements AuditLogSink {
  constructor(private invoke: InvokeFn) {}

  append(entry: ToolAuditEntry): void {
    // Fire-and-forget — audit writes are best-effort
    void this.invoke("db_execute", {
      sql: `INSERT OR REPLACE INTO tool_audit_log (call_id, turn_id, tool, args, decision, result, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        entry.callId,
        entry.turnId,
        entry.tool,
        JSON.stringify(entry.args),
        JSON.stringify(entry.decision),
        entry.result ? JSON.stringify(entry.result) : null,
        entry.timestamp,
      ],
    });
  }

  query(_turnId: string): ToolAuditEntry[] {
    // Sync interface — return empty. The Tauri version is async-backed but
    // the AuditLogSink interface is sync. Writes persist; reads use db_query.
    return [];
  }

  getAll(): ToolAuditEntry[] {
    return [];
  }
}

// === Storage Factory ===

function createTauriStorage(invoke: InvokeFn): StorageAdapters {
  return {
    eventStore: new TauriEventStore(invoke),
    memoryStorage: new TauriMemoryStorage(invoke),
    identityStorage: new InMemoryIdentityStorage(),
    auditLog: new InMemoryAuditLog(),
    toolAuditSink: new TauriToolAuditSink(invoke),
  };
}

function createDesktopStorage(config: DesktopAIConfig): StorageAdapters {
  if (config.isTauri && config.invoke) {
    return createTauriStorage(config.invoke);
  }
  return {
    eventStore: new InMemoryEventStore(),
    memoryStorage: new InMemoryMemoryStorage(),
    identityStorage: new InMemoryIdentityStorage(),
    auditLog: new InMemoryAuditLog(),
  };
}

// === Desktop App (platform shell) ===

export class DesktopApp {
  private runtime: MotebitRuntime | null = null;
  private renderer: ThreeJSAdapter;

  constructor() {
    this.renderer = new ThreeJSAdapter();
  }

  async init(canvas: unknown): Promise<void> {
    await this.renderer.init(canvas);
  }

  start(): void {
    this.runtime?.start();
  }

  stop(): void {
    this.runtime?.stop();
    this.renderer.dispose();
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  renderFrame(deltaTime: number, time: number): void {
    if (this.runtime) {
      this.runtime.renderFrame(deltaTime, time);
    } else {
      this.renderer.render({
        cues: { hover_distance: 0.4, drift_amplitude: 0.02, glow_intensity: 0.3, eye_dilation: 0.3, smile_curvature: 0 },
        delta_time: deltaTime,
        time,
      });
    }
  }

  // === AI Integration ===

  get isAIReady(): boolean {
    return this.runtime?.isAIReady ?? false;
  }

  get isProcessing(): boolean {
    return this.runtime?.isProcessing ?? false;
  }

  get currentModel(): string | null {
    return this.runtime?.currentModel ?? null;
  }

  setModel(model: string): void {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    this.runtime.setModel(model);
  }

  initAI(config: DesktopAIConfig): boolean {
    const resolved = config.personalityConfig
      ? resolveConfig(config.personalityConfig)
      : undefined;
    const temperature = resolved?.temperature;

    let provider;
    if (config.provider === "ollama") {
      const model = config.model || "llama3.2";
      const base_url = config.isTauri ? "http://localhost:11434" : "/api/ollama";
      provider = new OllamaProvider({ model, base_url, max_tokens: 1024, temperature });
    } else {
      if (!config.apiKey) return false;
      const model = config.model || "claude-sonnet-4-20250514";
      const base_url = config.isTauri ? "https://api.anthropic.com" : "/api/anthropic";
      provider = new CloudProvider({
        provider: "anthropic",
        api_key: config.apiKey,
        model,
        base_url,
        max_tokens: 1024,
        temperature,
      });
    }

    const storage = createDesktopStorage(config);
    const keyring = config.isTauri && config.invoke ? new TauriKeyringAdapter(config.invoke) : undefined;

    this.runtime = new MotebitRuntime(
      { motebitId: "desktop-local", tickRateHz: 2 },
      { storage, renderer: this.renderer, ai: provider, keyring },
    );

    return true;
  }

  get isOperatorMode(): boolean {
    return this.runtime?.isOperatorMode ?? false;
  }

  async setOperatorMode(enabled: boolean, pin?: string): Promise<OperatorModeResult> {
    if (!this.runtime) return { success: false, error: "AI not initialized" };
    return this.runtime.setOperatorMode(enabled, pin);
  }

  async setupOperatorPin(pin: string): Promise<void> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    return this.runtime.setupOperatorPin(pin);
  }

  async resetOperatorPin(): Promise<void> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    return this.runtime.resetOperatorPin();
  }

  resetConversation(): void {
    this.runtime?.resetConversation();
  }

  async sendMessage(text: string): Promise<TurnResult> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    return this.runtime.sendMessage(text);
  }

  async *sendMessageStreaming(text: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("AI not initialized — call initAI() first");
    yield* this.runtime.sendMessageStreaming(text);
  }
}

// === Slash Command Utilities ===

export function isSlashCommand(input: string): boolean {
  return input.startsWith("/");
}

export function parseSlashCommand(input: string): { command: string; args: string } {
  const spaceIdx = input.indexOf(" ");
  if (spaceIdx === -1) return { command: input.slice(1), args: "" };
  return { command: input.slice(1, spaceIdx), args: input.slice(spaceIdx + 1).trim() };
}
