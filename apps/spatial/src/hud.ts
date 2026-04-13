/**
 * Spatial HUD — the read-only essentials floor.
 *
 * Doctrine (CLAUDE.md, "Spatial rejects the panel metaphor"):
 * spatial never ports 2D panels. Read-only essentials — connection,
 * balance, active task — live here; structured data (credentials,
 * agents, memory, goals) belongs to spatial semantics as scene objects,
 * not rectangular panels. The HUD is the non-negotiable safety floor.
 *
 * Three fields, no controls:
 *   - connection: offline / connecting / online
 *   - balance: sovereign USDC balance
 *   - task: current active task or "idle"
 *
 * No click handlers for navigation. No expand/collapse. No settings.
 * If you catch yourself wanting to add a button here, stop and put
 * the feature in the scene.
 */

export type ConnectionState = "offline" | "connecting" | "online";

export interface HudBinding {
  setConnection(state: ConnectionState): void;
  setBalance(microUsdc: bigint | null): void;
  setTask(label: string | null): void;
}

export function formatBalance(micro: bigint | null): string {
  if (micro === null) return "— USDC";
  return `${(Number(micro) / 1_000_000).toFixed(2)} USDC`;
}

export function bindHud(root: HTMLElement): HudBinding {
  const connection = root.querySelector<HTMLElement>("#hud-connection");
  const balance = root.querySelector<HTMLElement>("#hud-balance");
  const task = root.querySelector<HTMLElement>("#hud-task");

  return {
    setConnection(state) {
      if (!connection) return;
      connection.textContent = state;
      connection.dataset["state"] = state;
    },
    setBalance(micro) {
      if (!balance) return;
      balance.textContent = formatBalance(micro);
    },
    setTask(label) {
      if (!task) return;
      task.textContent = label ?? "idle";
    },
  };
}
