import type { WebApp, BootedApp } from "./web-app";
import type { ProviderConfig } from "./storage";

declare global {
  interface Window {
    // Debug surface — intentionally full WebApp so test harnesses and
    // devtools can reach invokeComputer / dismissComputer directly.
    __motebitApp?: WebApp;
    __motebitReady?: boolean;
  }
}

export interface WebContext {
  app: BootedApp;
  getConfig(): ProviderConfig | null;
  setConfig(config: ProviderConfig): void;
  addMessage(role: "user" | "assistant" | "system", text: string): void;
  showToast(text: string, duration?: number): void;
  /** Bootstrap the proxy session — switches from local to cloud AI. */
  bootstrapProxy(): Promise<boolean>;
}
