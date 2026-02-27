// === Gated HUD Panels ===
// Memory panel is now functional (IDB-backed via runtime).
// Goals and Sync remain locked — accurate messaging for web surface.

import type { WebContext } from "../types";

export interface GatedPanelsAPI {
  openMemory(): void;
  closeAll(): void;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function initGatedPanels(ctx: WebContext): GatedPanelsAPI {
  // === Memory Panel (functional) ===
  const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
  const memoryBackdrop = document.getElementById("memory-backdrop") as HTMLDivElement;
  const memoryList = document.getElementById("memory-list") as HTMLDivElement;
  const memoryEmpty = document.getElementById("memory-empty") as HTMLDivElement;

  async function populateMemories(): Promise<void> {
    const runtime = ctx.app.getRuntime();
    if (!runtime) {
      memoryList.innerHTML = "";
      memoryEmpty.style.display = "block";
      memoryEmpty.textContent = "Runtime not initialized";
      return;
    }

    const { nodes } = await runtime.memory.exportAll();
    const active = nodes.filter(n => !n.tombstoned);

    memoryList.innerHTML = "";

    if (active.length === 0) {
      memoryEmpty.style.display = "block";
      memoryEmpty.textContent = "No memories yet. Start a conversation to build memory.";
      return;
    }

    memoryEmpty.style.display = "none";

    // Sort by most recent
    active.sort((a, b) => b.created_at - a.created_at);

    for (const node of active) {
      const item = document.createElement("div");
      item.className = "memory-item";

      const content = document.createElement("div");
      content.className = "memory-item-content";
      content.textContent = node.content;
      item.appendChild(content);

      const meta = document.createElement("div");
      meta.className = "memory-item-meta";

      const confidence = document.createElement("span");
      confidence.textContent = `${Math.round(node.confidence * 100)}%`;
      meta.appendChild(confidence);

      const time = document.createElement("span");
      time.textContent = formatTimeAgo(node.created_at);
      meta.appendChild(time);

      item.appendChild(meta);
      memoryList.appendChild(item);
    }
  }

  function openMemory(): void {
    closeAll();
    memoryPanel.classList.add("open");
    memoryBackdrop.classList.add("open");
    void populateMemories();
  }

  function closeMemory(): void {
    memoryPanel.classList.remove("open");
    memoryBackdrop.classList.remove("open");
  }

  document.getElementById("memory-btn")!.addEventListener("click", openMemory);
  document.getElementById("memory-close-btn")!.addEventListener("click", closeMemory);
  memoryBackdrop.addEventListener("click", closeMemory);

  // === Goals Panel (locked) ===
  const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
  const goalsBackdrop = document.getElementById("goals-backdrop") as HTMLDivElement;

  function openGoals(): void {
    closeAll();
    goalsPanel.classList.add("open");
    goalsBackdrop.classList.add("open");
  }

  function closeGoals(): void {
    goalsPanel.classList.remove("open");
    goalsBackdrop.classList.remove("open");
  }

  document.getElementById("goals-btn")!.addEventListener("click", openGoals);
  document.getElementById("goals-close-btn")!.addEventListener("click", closeGoals);
  goalsBackdrop.addEventListener("click", closeGoals);

  // === Sync Popup (locked) ===
  const syncStatus = document.getElementById("sync-status") as HTMLDivElement;
  const syncPopup = document.getElementById("sync-popup") as HTMLDivElement;

  function toggleSync(): void {
    if (syncPopup.classList.contains("open")) {
      syncPopup.classList.remove("open");
    } else {
      closeAll();
      // Position popup below the sync status indicator
      const rect = syncStatus.getBoundingClientRect();
      syncPopup.style.top = `${rect.bottom + 8}px`;
      syncPopup.style.left = `${rect.left + rect.width / 2}px`;
      syncPopup.style.transform = "translateX(-50%)";
      syncPopup.classList.add("open");
    }
  }

  syncStatus.addEventListener("click", toggleSync);

  // Close sync popup on outside click
  document.addEventListener("click", (e) => {
    if (syncPopup.classList.contains("open") &&
        !syncPopup.contains(e.target as Node) &&
        !syncStatus.contains(e.target as Node)) {
      syncPopup.classList.remove("open");
    }
  });

  // === Close All ===
  function closeAll(): void {
    closeMemory();
    closeGoals();
    syncPopup.classList.remove("open");
  }

  return { openMemory, closeAll };
}
