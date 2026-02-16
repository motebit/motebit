/**
 * @motebit/desktop — Tauri app (Rust + webview)
 *
 * Architecture:
 * - Three.js in webview for rendering
 * - SQLite via rusqlite in Rust backend, exposed through Tauri commands
 * - OS keyring for identity persistence (via tauri-plugin-keyring)
 * - System tray presence
 *
 * Tauri commands (Rust side):
 * - db_query(sql, params) -> rows
 * - db_execute(sql, params) -> affected
 * - keyring_get(key) -> value
 * - keyring_set(key, value)
 * - keyring_delete(key)
 */

import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { ThreeJSAdapter } from "@motebit/render-engine";

// === Tauri Command Interface ===

export interface TauriCommands {
  db_query(sql: string, params: unknown[]): Promise<unknown[]>;
  db_execute(sql: string, params: unknown[]): Promise<number>;
  keyring_get(key: string): Promise<string | null>;
  keyring_set(key: string, value: string): Promise<void>;
  keyring_delete(key: string): Promise<void>;
}

// === Desktop App Bootstrap ===

export class DesktopApp {
  private stateEngine: StateVectorEngine;
  private behaviorEngine: BehaviorEngine;
  private renderer: ThreeJSAdapter;
  private running = false;

  constructor() {
    this.stateEngine = new StateVectorEngine({ tick_rate_hz: 2 });
    this.behaviorEngine = new BehaviorEngine();
    this.renderer = new ThreeJSAdapter();
  }

  async init(canvas: unknown): Promise<void> {
    await this.renderer.init(canvas);

    // Subscribe to state changes → compute cues → render
    this.stateEngine.subscribe((state: MotebitState) => {
      const cues: BehaviorCues = this.behaviorEngine.compute(state);
      this.renderer.render({
        cues,
        delta_time: 1 / 60,
        time: Date.now() / 1000,
      });
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stateEngine.start();
  }

  stop(): void {
    this.stateEngine.stop();
    this.renderer.dispose();
    this.running = false;
  }
}
