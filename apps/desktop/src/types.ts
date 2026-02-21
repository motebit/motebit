import type { DesktopApp, DesktopAIConfig } from "./index";

export type MicState = "off" | "ambient" | "voice" | "transcribing" | "speaking";

export interface DesktopContext {
  app: DesktopApp;
  getConfig(): DesktopAIConfig | null;
  setConfig(config: DesktopAIConfig): void;
  addMessage(role: "user" | "assistant" | "system", text: string): void;
  showToast(text: string, duration?: number): void;
}

export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
