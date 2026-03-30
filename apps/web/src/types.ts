import type { WebApp } from "./web-app";
import type { ProviderConfig } from "./storage";

export interface WebContext {
  app: WebApp;
  getConfig(): ProviderConfig | null;
  setConfig(config: ProviderConfig): void;
  addMessage(role: "user" | "assistant" | "system", text: string): void;
  showToast(text: string, duration?: number): void;
  /** Bootstrap the proxy session — switches from local to cloud AI. */
  bootstrapProxy(): Promise<boolean>;
}
